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
import { statSync } from "node:fs"

import { defaultDataDir, resolveDbPath } from "./dbpath.js"

export { defaultDataDir, resolveDbPath }

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

/** Max event rows deleted in a single statement (keeps DB write locks short). */
export const DEFAULT_EVENT_BATCH = 500

/** Max part rows rewritten in a single prune transaction (keeps DB locks short). */
export const DEFAULT_PART_BATCH = 500

/** Default WAL size (bytes) above which the governor issues a PASSIVE checkpoint. */
export const DEFAULT_WAL_THRESHOLD = 64 * 1024 * 1024

/** Default idle window (ms): with no write this recent, the governor TRUNCATEs the WAL. */
export const DEFAULT_WAL_IDLE_MS = 15_000

/** Default spacing (ms) between WAL governor ticks. */
export const DEFAULT_WAL_CHECK_MS = 30_000

/** Default floor (ms) between adaptive prune passes once the DB/WAL is over threshold. */
export const DEFAULT_PRUNE_FLOOR_MS = 30 * 60 * 1000

/** Default max random jitter (ms) added to the floor interval, to de-sync processes. */
export const DEFAULT_PRUNE_JITTER_MS = 60_000

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
 *   eventBatch: number,
 *   partBatch: number,
 *   walThreshold: number,
 *   walIdleMs: number,
 *   walCheckMs: number,
 *   pruneFloorMs: number,
 *   pruneJitterMs: number,
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
    eventBatch: envNumber(env, "OPENCODE_DB_CLEANUP_EVENT_BATCH", DEFAULT_EVENT_BATCH),
    partBatch: envNumber(env, "OPENCODE_DB_CLEANUP_PART_BATCH", DEFAULT_PART_BATCH),
    walThreshold: envNumber(env, "OPENCODE_DB_CLEANUP_WAL_THRESHOLD", DEFAULT_WAL_THRESHOLD),
    walIdleMs: envNumber(env, "OPENCODE_DB_CLEANUP_WAL_IDLE_MS", DEFAULT_WAL_IDLE_MS),
    walCheckMs: envNumber(env, "OPENCODE_DB_CLEANUP_WAL_CHECK_MS", DEFAULT_WAL_CHECK_MS),
    pruneFloorMs: envNumber(env, "OPENCODE_DB_CLEANUP_PRUNE_FLOOR_MS", DEFAULT_PRUNE_FLOOR_MS),
    pruneJitterMs: envNumber(env, "OPENCODE_DB_CLEANUP_PRUNE_JITTER_MS", DEFAULT_PRUNE_JITTER_MS),
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
 * Resolve the `-wal` sidecar path for a SQLite database path. Returns
 * `undefined` for an in-memory database, which has no WAL file.
 *
 * @param {string | undefined} dbPath
 * @returns {string | undefined}
 */
export function walPath(dbPath) {
  if (!dbPath || dbPath === ":memory:") return undefined
  return `${dbPath}-wal`
}

/**
 * Read the current WAL sidecar size in bytes, or `0` when the file is absent
 * (a checkpointed/truncated WAL) or the path is unusable. Best-effort: a stat
 * failure never throws, so the governor simply sees "no WAL".
 *
 * @param {string | undefined} dbPath
 * @param {(path: string) => number} [sizeOf]
 * @returns {number}
 */
export function walSize(dbPath, sizeOf = (p) => statSync(p).size) {
  const path = walPath(dbPath)
  if (!path) return 0
  try {
    return sizeOf(path)
  } catch {
    return 0
  }
}

/**
 * Read the shared WAL sidecar's last-modified time in ms, or `0` when the file
 * is absent or the path is unusable. Because the WAL file is shared by every
 * OpenCode process on the same database, its mtime is a GLOBAL "last write"
 * signal: a write by ANY process bumps it. Best-effort, mirroring {@link walSize}.
 *
 * @param {string | undefined} dbPath
 * @param {(path: string) => number} [mtimeOf]
 * @returns {number}
 */
export function walMtimeMs(dbPath, mtimeOf = (p) => statSync(p).mtimeMs) {
  const path = walPath(dbPath)
  if (!path) return 0
  try {
    return mtimeOf(path)
  } catch {
    return 0
  }
}

/**
 * Delete `event` rows and trim `part` rows for sessions inactive longer than
 * the retention window.
 *
 * `event_sequence` is left intact on purpose: new sequence numbers are derived
 * from it, so removing it would cause collisions. `session` / `message` rows
 * are never removed, so the model's projection history stays intact.
 *
 * Both mutations are bounded to small batches (`eventBatch` / `partBatch` rows
 * per statement). A plugin shares the database with the running OpenCode
 * process, whose writes fail with "database is locked" when another writer holds
 * the SQLite write lock past `busy_timeout`; on a multi-GB database a single
 * unbounded `DELETE` over hundreds of sessions can hold that lock for seconds.
 * Batched statements keep each lock window to milliseconds.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{
 *   retentionMs: number,
 *   partPreviewChars: number,
 *   eventBatch: number,
 *   partBatch: number,
 *   now?: number,
 *   debug?: boolean,
 * }} options
 * @returns {{ sessions: number, eventsDeleted: number, partsTrimmed: number }}
 */
export function pruneDatabase(db, options) {
  const now = options.now ?? Date.now()
  const cutoff = now - options.retentionMs
  const eventBatch = Math.max(1, Math.floor(options.eventBatch ?? DEFAULT_EVENT_BATCH))
  const partBatch = Math.max(1, Math.floor(options.partBatch ?? DEFAULT_PART_BATCH))

  const inactive = db
    .query("SELECT id FROM session WHERE time_updated < ?")
    .all(cutoff)
    .map((row) => row.id)

  if (inactive.length === 0) {
    return { sessions: 0, eventsDeleted: 0, partsTrimmed: 0 }
  }

  const placeholders = inactive.map(() => "?").join(",")

  // Delete in bounded batches: each statement commits after at most `eventBatch`
  // rows, so the write lock is never held for a full multi-session sweep.
  const deleteEvents = db.prepare(
    `DELETE FROM event WHERE rowid IN (
       SELECT rowid FROM event WHERE aggregate_id IN (${placeholders}) LIMIT ?
     )`,
  )
  let eventsDeleted = 0
  for (;;) {
    const changes = deleteEvents.run(...inactive, eventBatch).changes
    eventsDeleted += changes
    if (changes < eventBatch) break
  }

  const parts = db
    .query(
      `SELECT id, data FROM part
       WHERE session_id IN (${placeholders})
         AND json_extract(data, '$.type') = 'tool'
       LIMIT ?`,
    )
    .all(...inactive, partBatch)

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
        `${eventsDeleted} event row(s) deleted, ${partsTrimmed} part(s) trimmed`,
    )
  }

  return { sessions: inactive.length, eventsDeleted, partsTrimmed }
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
 * Truncate the WAL back to zero bytes. Unlike {@link checkpointPassive} this
 * takes a short exclusive lock on the WAL, so the caller MUST ensure no write
 * occurred recently (`now - lastWriteAt >= walIdleMs`); otherwise it can make a
 * concurrent writer fail with "database is locked".
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{ debug?: boolean }} [options]
 * @returns {{ checkpointed: boolean }}
 */
export function checkpointTruncate(db, options = {}) {
  let checkpointed = false
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    checkpointed = true
  } catch (error) {
    if (options.debug) console.error("[opencode-db-cleanup] wal_checkpoint(TRUNCATE) failed", error)
  }
  return { checkpointed }
}

/**
 * Decide and run the WAL governor action for one tick.
 *
 * OpenCode core runs its own in-transaction WAL auto-checkpoint
 * (`wal_autocheckpoint`, ~4 MiB by default), which fires inside a write
 * transaction and turns a write into an IO-block storm. The plugin cannot change
 * core's per-connection PRAGMA, but it CAN keep the WAL small so core's
 * auto-checkpoint rarely fires:
 *
 *   - no WAL at all → nothing to do;
 *   - a write within `walIdleMs` → at most a non-blocking
 *     `wal_checkpoint(PASSIVE)` when the WAL exceeds `walThreshold`;
 *   - quiescent (`now - lastWriteAt >= walIdleMs`) with a non-empty WAL →
 *     `wal_checkpoint(TRUNCATE)` to shrink it.
 *
 * TRUNCATE is never issued while a write occurred within `walIdleMs`.
 *
 * @param {import("bun:sqlite").Database} db
 * @param {{
 *   walSizeBytes: number,
 *   lastWriteAt: number,
 *   now: number,
 *   walThreshold: number,
 *   walIdleMs: number,
 *   walMtimeMs?: number,
 *   debug?: boolean,
 * }} options
 * @returns {{ action: "none" | "passive" | "truncate", walSize: number, idle: number }}
 */
export function governWal(db, options) {
  const { walSizeBytes, lastWriteAt, now, walThreshold, walIdleMs, debug } = options
  // Idle is GLOBAL: the shared WAL mtime captures writes by ANY process on the
  // same database, so an idle process never TRUNCATEs while a peer is writing.
  const walMtimeMs = options.walMtimeMs ?? 0
  const idle = now - Math.max(lastWriteAt, walMtimeMs)
  if (!(walSizeBytes > 0)) return { action: "none", walSize: walSizeBytes, idle }
  if (idle >= walIdleMs) {
    checkpointTruncate(db, { debug })
    return { action: "truncate", walSize: walSizeBytes, idle }
  }
  if (walSizeBytes > walThreshold) {
    checkpointPassive(db, { debug })
    return { action: "passive", walSize: walSizeBytes, idle }
  }
  return { action: "none", walSize: walSizeBytes, idle }
}

/**
 * Create the cleanup feature: the write-time capping hook, the throttled
 * retention-prune hook, the WAL governor, and a disposal callback.
 *
 * @param {{
 *   limits?: ReturnType<typeof resolveLimits>,
 *   dbPath?: string,
 *   now?: () => number,
 *   openDb?: (path: string) => import("bun:sqlite").Database,
 *   sizeOf?: (path: string) => number,
 *   mtimeOf?: (path: string) => number,
 *   random?: () => number,
 *   onError?: (error: unknown) => void,
 * }} [options]
 * @returns {{
 *   limits: ReturnType<typeof resolveLimits>,
 *   cap: (input: unknown, output: any) => void,
 *   event: (input: { event?: unknown }) => Promise<void>,
 *   walGovern: () => { action: "none" | "passive" | "truncate", walSize: number, idle: number, throttled?: boolean } | undefined,
 *   markWrite: () => void,
 *   dispose: () => Promise<void>,
 *   runPrune: () => { sessions: number, eventsDeleted: number, partsTrimmed: number } | undefined,
 * }}
 */
export function createCleanup(options = {}) {
  const limits = options.limits ?? resolveLimits()
  const now = options.now ?? (() => Date.now())
  const openDb = options.openDb ?? ((path) => new Database(path, { readwrite: true, create: false }))
  const sizeOf = options.sizeOf ?? ((p) => statSync(p).size)
  const mtimeOf = options.mtimeOf ?? ((p) => statSync(p).mtimeMs)
  const random = options.random ?? Math.random
  const onError =
    options.onError ??
    ((error) => {
      if (limits.debug) console.error("[opencode-db-cleanup] prune failed", error)
    })
  const dbPath = options.dbPath ?? resolveDbPath()

  let db
  let lastRun = 0
  let lastWalGovern = 0
  let lastWriteAt = 0
  /** Earliest time the next adaptive (floor-interval) prune may run. */
  let nextAdaptivePruneAt = 0
  let running = false
  let dirty = false

  function connection() {
    if (db) return db
    if (!dbPath) return undefined
    db = openDb(dbPath)
    db.run("PRAGMA busy_timeout = 5000")
    return db
  }

  /** Record that a DB write just happened, so the WAL governor stays passive. */
  function markWrite() {
    lastWriteAt = now()
  }

  function runPrune() {
    const handle = connection()
    if (!handle) return undefined
    const result = pruneDatabase(handle, {
      retentionMs: limits.retentionMs,
      partPreviewChars: limits.partPreviewChars,
      eventBatch: limits.eventBatch,
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
    markWrite()
    capToolResult(output, limits)
  }

  /**
   * One WAL governor tick, throttled to `walCheckMs`. Cheap and safe to call
   * from the event fan-out (which also covers active-write pressure) and from a
   * periodic timer (which covers the idle case, when no events fire).
   */
  function walGovern() {
    const stamp = now()
    if (stamp - lastWalGovern < limits.walCheckMs) {
      return { action: "none", walSize: 0, idle: 0, throttled: true }
    }
    lastWalGovern = stamp
    const handle = connection()
    if (!handle) return undefined
    const size = walSize(dbPath, sizeOf)
    return governWal(handle, {
      walSizeBytes: size,
      lastWriteAt,
      now: stamp,
      walThreshold: limits.walThreshold,
      walIdleMs: limits.walIdleMs,
      walMtimeMs: walMtimeMs(dbPath, mtimeOf),
      debug: limits.debug,
    })
  }

  async function event() {
    // Any event implies recent session activity, so keep the governor passive.
    markWrite()
    const stamp = now()
    try {
      walGovern()
    } catch (error) {
      onError(error)
    }
    if (running) return
    // Regular 6h pass, or an earlier adaptive pass when the WAL is over the
    // threshold and the (jittered) floor interval has elapsed. The jitter
    // de-synchronizes the 2-5 processes sharing the database so they do not all
    // prune in lockstep.
    const regular = stamp - lastRun >= limits.intervalMs
    const adaptive =
      !regular && stamp >= nextAdaptivePruneAt && walSize(dbPath, sizeOf) > limits.walThreshold
    if (!regular && !adaptive) return
    running = true
    lastRun = stamp
    nextAdaptivePruneAt = stamp + limits.pruneFloorMs + Math.floor(random() * limits.pruneJitterMs)
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
    walGovern,
    markWrite,
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
