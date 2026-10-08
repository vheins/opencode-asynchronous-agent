/**
 * Opt-in database cleanup for the OpenCode V1 plugin entrypoint.
 *
 * OpenCode stores every session twice: the projection tables the model reads
 * (`session` / `message` / `part`) and the event-sourcing log (`event` +
 * `event_sequence`). Large tool results are also persisted verbatim in both,
 * so a long-lived database grows without bound (multi-GB `event` and `part`).
 *
 * This module reclaims that space in two independent, safe layers:
 *
 *   1. Write-time capping (`capToolResult`) — via the V1 `tool.execute.after`
 *      hook, truncates oversized tool output and UI-only metadata (`diff`,
 *      `filediff.patch`, `display.text`) before it is persisted. This shrinks
 *      both the projection and the mirrored event.
 *
 *   2. Retention pruning (`pruneDatabase`) — deletes `event` rows and trims
 *      `part` rows for sessions whose `time_updated` is older than the
 *      retention window. It NEVER touches `event_sequence` (so new event
 *      sequence numbers never collide) and never deletes `session` rows (so
 *      the model's projection history is preserved).
 *
 * Everything is configurable through environment variables and defaults to a
 * conservative, self-limiting policy.
 *
 * @module cleanup
 */

import { Database } from "bun:sqlite"
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Marker appended where content was truncated. */
export const TRUNCATION_MARKER = "\n...[truncated by opencode-db-cleanup]...\n"

/** Default age (ms) before an inactive session's events/parts are pruned. */
export const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

/** Default minimum delay (ms) between two prune passes. */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Default max characters kept for a tool result output at write time. */
export const DEFAULT_MAX_OUTPUT_CHARS = 100_000

/** Default max characters kept for UI-only diff metadata at write time. */
export const DEFAULT_MAX_DIFF_CHARS = 64_000

/** Default max characters kept for UI-only display text at write time. */
export const DEFAULT_MAX_DISPLAY_CHARS = 64_000

/** Default max characters kept for the UI-only LSP diagnostics blob. */
export const DEFAULT_MAX_DIAGNOSTICS_CHARS = 32_000

/** Default preview size retained when trimming an old tool part. */
export const DEFAULT_PART_PREVIEW_CHARS = 2_000

/** Max part rows rewritten in a single prune pass (keeps DB locks short). */
export const DEFAULT_PART_BATCH = 500

/** Values accepted as "enabled"/"disabled" for boolean env gates. */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"])
const FALSY = new Set(["0", "false", "no", "off", "n"])

/**
 * Whether the cleanup feature is enabled. Defaults to enabled; set
 * `OPENCODE_DB_CLEANUP=0` to disable it entirely.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function cleanupEnabled(env = process.env) {
  const raw = String(env.OPENCODE_DB_CLEANUP ?? "").trim().toLowerCase()
  if (FALSY.has(raw)) return false
  return true
}

/**
 * Read a positive numeric env override, falling back to `fallback`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
export function envNumber(env, key, fallback) {
  const raw = Number(String(env[key] ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Resolve the effective cleanup limits from the environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   retentionMs: number,
 *   intervalMs: number,
 *   maxOutputChars: number,
 *   maxDiffChars: number,
 *   maxDisplayChars: number,
 *   maxDiagnosticsChars: number,
 *   partPreviewChars: number,
 *   partBatch: number,
 *   vacuum: boolean,
 *   debug: boolean,
 * }}
 */
export function resolveLimits(env = process.env) {
  return {
    retentionMs: envNumber(env, "OPENCODE_DB_CLEANUP_RETENTION_MS", DEFAULT_RETENTION_MS),
    intervalMs: envNumber(env, "OPENCODE_DB_CLEANUP_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    maxOutputChars: envNumber(env, "OPENCODE_DB_CLEANUP_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS),
    maxDiffChars: envNumber(env, "OPENCODE_DB_CLEANUP_MAX_DIFF_CHARS", DEFAULT_MAX_DIFF_CHARS),
    maxDisplayChars: envNumber(env, "OPENCODE_DB_CLEANUP_MAX_DISPLAY_CHARS", DEFAULT_MAX_DISPLAY_CHARS),
    maxDiagnosticsChars: envNumber(
      env,
      "OPENCODE_DB_CLEANUP_MAX_DIAGNOSTICS_CHARS",
      DEFAULT_MAX_DIAGNOSTICS_CHARS,
    ),
    partPreviewChars: envNumber(env, "OPENCODE_DB_CLEANUP_PART_PREVIEW_CHARS", DEFAULT_PART_PREVIEW_CHARS),
    partBatch: envNumber(env, "OPENCODE_DB_CLEANUP_PART_BATCH", DEFAULT_PART_BATCH),
    vacuum: TRUTHY.has(String(env.OPENCODE_DB_CLEANUP_VACUUM ?? "").trim().toLowerCase()),
    debug: String(env.OPENCODE_DB_CLEANUP_DEBUG ?? "") === "1",
  }
}

/**
 * Truncate a string to at most `max` characters, keeping the head and tail so
 * both the start and end of the content stay readable.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateMiddle(text, max) {
  if (typeof text !== "string" || text.length <= max) return text
  const budget = max - TRUNCATION_MARKER.length
  if (budget <= 0) return text.slice(0, max)
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(text.length - tail)
}

/**
 * Cap a tool result in place before it is persisted. Mutates `output` (the V1
 * `tool.execute.after` contract) and returns whether anything changed.
 *
 * `output.output` is model-visible, so it is capped only at a high ceiling;
 * the diff/display fields are UI-only and are capped more aggressively.
 *
 * @param {{ output?: unknown, metadata?: Record<string, any> }} output
 * @param {{ maxOutputChars: number, maxDiffChars: number, maxDisplayChars: number, maxDiagnosticsChars: number }} limits
 * @returns {boolean}
 */
export function capToolResult(output, limits) {
  if (!output || typeof output !== "object") return false
  let changed = false

  if (typeof output.output === "string" && output.output.length > limits.maxOutputChars) {
    output.output = truncateMiddle(output.output, limits.maxOutputChars)
    changed = true
  }

  const metadata = output.metadata
  if (metadata && typeof metadata === "object") {
    if (typeof metadata.diff === "string" && metadata.diff.length > limits.maxDiffChars) {
      metadata.diff = truncateMiddle(metadata.diff, limits.maxDiffChars)
      changed = true
    }
    if (metadata.filediff && typeof metadata.filediff === "object") {
      const patch = metadata.filediff.patch
      if (typeof patch === "string" && patch.length > limits.maxDiffChars) {
        metadata.filediff.patch = truncateMiddle(patch, limits.maxDiffChars)
        changed = true
      }
    }
    if (metadata.display && typeof metadata.display === "object") {
      const text = metadata.display.text
      if (typeof text === "string" && text.length > limits.maxDisplayChars) {
        metadata.display.text = truncateMiddle(text, limits.maxDisplayChars)
        changed = true
      }
    }
    if (metadata.diagnostics !== undefined) {
      const serialized = JSON.stringify(metadata.diagnostics)
      if (serialized.length > limits.maxDiagnosticsChars) {
        metadata.diagnostics = {}
        changed = true
      }
    }
  }

  return changed
}

/**
 * Trim a persisted tool part's JSON so only a small preview remains, and mark
 * it compacted. Returns the new JSON string, or `undefined` when the part is
 * not a completed tool part or was already trimmed.
 *
 * @param {string} json
 * @param {{ now: number, previewChars: number }} options
 * @returns {string | undefined}
 */
export function trimPartData(json, options) {
  let part
  try {
    part = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!part || part.type !== "tool") return undefined
  const state = part.state
  if (!state || state.status !== "completed") return undefined

  let changed = false
  if (typeof state.output === "string" && state.output.length > options.previewChars) {
    state.output = truncateMiddle(state.output, options.previewChars)
    changed = true
  }
  if (state.time && state.time.compacted === undefined) {
    state.time.compacted = options.now
    changed = true
  }
  const metadata = state.metadata
  if (metadata && typeof metadata === "object") {
    if (typeof metadata.diff === "string") {
      delete metadata.diff
      changed = true
    }
    if (metadata.filediff && typeof metadata.filediff === "object" && "patch" in metadata.filediff) {
      delete metadata.filediff.patch
      changed = true
    }
    if (metadata.display && typeof metadata.display === "object" && "text" in metadata.display) {
      delete metadata.display.text
      changed = true
    }
    if ("diagnostics" in metadata) {
      delete metadata.diagnostics
      changed = true
    }
  }

  return changed ? JSON.stringify(part) : undefined
}

/**
 * Resolve the OpenCode SQLite database path.
 *
 * Mirrors `Database.path()`: `OPENCODE_DB` wins (absolute or `:memory:`), a
 * relative value is joined to the data directory, and otherwise the most
 * recently modified `opencode*.db` in the data directory is used (covering the
 * channel-suffixed names). Returns `undefined` when nothing is found.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   dataDir?: string,
 *   readdir?: (dir: string) => string[],
 *   mtime?: (path: string) => number,
 * }} [options]
 * @returns {string | undefined}
 */
export function resolveDbPath(options = {}) {
  const env = options.env ?? process.env
  const dataDir = options.dataDir ?? defaultDataDir(env)
  const readdir = options.readdir ?? ((dir) => readdirSync(dir))
  const mtime = options.mtime ?? ((p) => statSync(p).mtimeMs)

  const explicit = String(env.OPENCODE_DB ?? "").trim()
  if (explicit === ":memory:") return explicit
  if (explicit) {
    return explicit.startsWith("/") ? explicit : join(dataDir, explicit)
  }

  let entries
  try {
    entries = readdir(dataDir)
  } catch {
    return undefined
  }
  const candidates = entries.filter(
    (name) => name.startsWith("opencode") && name.endsWith(".db") && !name.endsWith("-wal") && !name.endsWith("-shm"),
  )
  if (candidates.length === 0) return undefined
  const preferred = candidates.find((name) => name === "opencode.db")
  if (preferred) return join(dataDir, preferred)

  let best
  let bestMtime = -1
  for (const name of candidates) {
    const full = join(dataDir, name)
    const stamp = mtime(full)
    if (stamp > bestMtime) {
      bestMtime = stamp
      best = full
    }
  }
  return best
}

/**
 * Resolve the OpenCode data directory (`$XDG_DATA_HOME/opencode` or
 * `~/.local/share/opencode`).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultDataDir(env = process.env) {
  const xdg = String(env.XDG_DATA_HOME ?? "").trim()
  const base = xdg || join(homedir(), ".local", "share")
  return join(base, "opencode")
}

/**
 * Delete `event` rows and trim `part` rows for sessions inactive longer than
 * the retention window.
 *
 * `event_sequence` is left intact on purpose: new sequence numbers are derived
 * from it, so removing it would cause collisions. `session` / `message` rows
 * are never removed, so the model's projection history stays intact.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{
 *   retentionMs: number,
 *   partPreviewChars: number,
 *   partBatch: number,
 *   now?: number,
 *   debug?: boolean,
 * }} options
 * @returns {{ sessions: number, eventsDeleted: number, partsTrimmed: number }}
 */
export function pruneDatabase(db, options) {
  const now = options.now ?? Date.now()
  const cutoff = now - options.retentionMs

  const inactive = db
    .query("SELECT id FROM session WHERE time_updated < ?")
    .all(cutoff)
    .map((row) => row.id)

  if (inactive.length === 0) {
    return { sessions: 0, eventsDeleted: 0, partsTrimmed: 0 }
  }

  const placeholders = inactive.map(() => "?").join(",")

  const eventResult = db.run(`DELETE FROM event WHERE aggregate_id IN (${placeholders})`, inactive)

  const parts = db
    .query(
      `SELECT id, data FROM part
       WHERE session_id IN (${placeholders})
         AND json_extract(data, '$.type') = 'tool'
       LIMIT ?`,
    )
    .all(...inactive, options.partBatch)

  let partsTrimmed = 0
  const update = db.prepare("UPDATE part SET data = ? WHERE id = ?")
  const tx = db.transaction(() => {
    for (const row of parts) {
      const next = trimPartData(row.data, { now, previewChars: options.partPreviewChars })
      if (next === undefined) continue
      update.run(next, row.id)
      partsTrimmed++
    }
  })
  tx()

  if (options.debug) {
    console.error(
      `[opencode-db-cleanup] pruned ${inactive.length} inactive session(s): ` +
        `${eventResult.changes} event row(s) deleted, ${partsTrimmed} part(s) trimmed`,
    )
  }

  return { sessions: inactive.length, eventsDeleted: eventResult.changes, partsTrimmed }
}

/**
 * Checkpoint the WAL without blocking other writers.
 *
 * A plugin runs inside the same OpenCode process that owns the database, and
 * other sessions write to it concurrently. `wal_checkpoint(TRUNCATE)` and
 * `VACUUM` take locks that make those concurrent writes fail with
 * "database is locked", so the live path only ever uses a PASSIVE checkpoint
 * (which never blocks and returns immediately if a reader is active).
 *
 * The heavier reclaim (TRUNCATE + optional VACUUM) is deferred to {@link dispose}
 * when the process is shutting down and contention is gone.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ debug?: boolean }} [options]
 * @returns {{ checkpointed: boolean }}
 */
export function checkpointPassive(db, options = {}) {
  let checkpointed = false
  try {
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    checkpointed = true
  } catch (error) {
    if (options.debug) console.error("[opencode-db-cleanup] wal_checkpoint(PASSIVE) failed", error)
  }
  return { checkpointed }
}

/**
 * Run a blocking WAL checkpoint and optionally a full VACUUM to reclaim free
 * pages. Intended for shutdown only (`dispose`), never while sessions are live.
 *
 * `wal_checkpoint(TRUNCATE)` is cheap and always attempted. `VACUUM` rewrites
 * the whole database and needs exclusive access, so it is opt-in
 * (`OPENCODE_DB_CLEANUP_VACUUM=1`) and best-effort.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ vacuum: boolean, debug?: boolean }} options
 * @returns {{ checkpointed: boolean, vacuumed: boolean }}
 */
export function reclaimSpace(db, options) {
  let checkpointed = false
  let vacuumed = false
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    checkpointed = true
  } catch (error) {
    if (options.debug) console.error("[opencode-db-cleanup] wal_checkpoint failed", error)
  }
  if (options.vacuum) {
    try {
      db.run("VACUUM")
      vacuumed = true
    } catch (error) {
      if (options.debug) console.error("[opencode-db-cleanup] VACUUM failed", error)
    }
  }
  return { checkpointed, vacuumed }
}

/**
 * Create the cleanup feature: the write-time capping hook, the throttled
 * retention-prune hook, and a disposal callback.
 *
 * @param {{
 *   limits?: ReturnType<typeof resolveLimits>,
 *   dbPath?: string,
 *   now?: () => number,
 *   openDb?: (path: string) => import("bun:sqlite").Database,
 *   onError?: (error: unknown) => void,
 * }} [options]
 * @returns {{
 *   limits: ReturnType<typeof resolveLimits>,
 *   cap: (input: unknown, output: any) => void,
 *   event: (input: { event?: unknown }) => Promise<void>,
 *   dispose: () => Promise<void>,
 *   runPrune: () => { sessions: number, eventsDeleted: number, partsTrimmed: number } | undefined,
 * }}
 */
export function createCleanup(options = {}) {
  const limits = options.limits ?? resolveLimits()
  const now = options.now ?? (() => Date.now())
  const openDb = options.openDb ?? ((path) => new Database(path, { readwrite: true, create: false }))
  const onError =
    options.onError ??
    ((error) => {
      if (limits.debug) console.error("[opencode-db-cleanup] prune failed", error)
    })
  const dbPath = options.dbPath ?? resolveDbPath()

  let db
  let lastRun = 0
  let running = false
  let dirty = false

  function connection() {
    if (db) return db
    if (!dbPath) return undefined
    db = openDb(dbPath)
    db.run("PRAGMA busy_timeout = 5000")
    return db
  }

  function runPrune() {
    const handle = connection()
    if (!handle) return undefined
    const result = pruneDatabase(handle, {
      retentionMs: limits.retentionMs,
      partPreviewChars: limits.partPreviewChars,
      partBatch: limits.partBatch,
      now: now(),
      debug: limits.debug,
    })
    if (result.sessions > 0 || result.partsTrimmed > 0) {
      dirty = true
      // PASSIVE only: a blocking checkpoint or VACUUM here locks the database
      // out from the sessions OpenCode is actively writing. The heavy reclaim
      // runs at dispose (see below).
      checkpointPassive(handle, { debug: limits.debug })
    }
    return result
  }

  function cap(_input, output) {
    capToolResult(output, limits)
  }

  async function event() {
    const stamp = now()
    if (running || stamp - lastRun < limits.intervalMs) return
    running = true
    lastRun = stamp
    try {
      runPrune()
    } catch (error) {
      onError(error)
    } finally {
      running = false
    }
  }

  return {
    limits,
    cap,
    event,
    runPrune,
    dispose: async () => {
      if (db) {
        // Shutdown: contention is gone, so the blocking reclaim is safe now.
        if (dirty) {
          try {
            reclaimSpace(db, { vacuum: limits.vacuum, debug: limits.debug })
          } catch (error) {
            onError(error)
          }
        }
        db.close()
        db = undefined
      }
    },
  }
}
