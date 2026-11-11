/**
 * Pure liveness math and reporting for background subagent sessions.
 *
 * Extracted from `./subagent-status.js` so the registry (which touches the
 * OpenCode event stream and the SDK) stays small, and so the classification and
 * formatting rules can be unit-tested without a runtime.
 *
 * Liveness uses two clocks. `lastProgressAt` advances only on STRONG evidence
 * that the child did work (message/todo updates, a `busy`/`retry` status);
 * `lastEventAt` advances on any event and is bookkeeping only. Staleness is
 * derived from the progress clock alone, so a chatty but idle child cannot
 * masquerade as running.
 *
 * An in-flight TOOL CALL counts as proof of life even when it emits no session
 * events: a child running `bash` (build, install, test suite) can legitimately
 * sit for many minutes. Each tracked `tool` part is recorded by call id and only
 * stops counting once it has run past `OPENCODE_SUBAGENT_TOOL_GRACE_MS`.
 *
 * `stale` and `dead` are DERIVED states: they are never written into
 * `record.status`, which stays the lifecycle base (`running` / `done` /
 * `error`). A child that emits progress after finishing therefore returns to
 * `running` cleanly.
 *
 * @module subagent-liveness
 */

import { STATUS_ORDER, formatDuration, renderChildHeader, renderChildLines } from "./subagent-format.js"

/** Default age (ms) without progress after which a running child is stale. */
export const DEFAULT_STALE_MS = 120000

/** Default age (ms) without progress after which a running child is dead. */
export const DEFAULT_DEAD_MS = 600000

/** Default age (ms) an in-flight tool call keeps counting as proof of life. */
export const DEFAULT_TOOL_GRACE_MS = 1800000

/** How long (ms) a finished child stays in the registry before being pruned. */
export const DONE_RETENTION_MS = 3600000

/** Default minimum delay (ms) between two SDK reconciliation passes. */
export const DEFAULT_RECONCILE_MS = 1000

/**
 * Read a positive integer from an environment variable, falling back when unset
 * or not a positive finite number.
 *
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
export function envInt(key, fallback) {
  const raw = Number(String(process.env[key] ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/**
 * Configured staleness threshold in milliseconds. Falls back to
 * {@link DEFAULT_STALE_MS} when unset or not a positive number.
 *
 * @returns {number}
 */
export function staleThresholdMs() {
  return envInt("OPENCODE_SUBAGENT_STALE_MS", DEFAULT_STALE_MS)
}

/**
 * Configured dead-session threshold in milliseconds. Reads
 * `OPENCODE_SUBAGENT_DEAD_MS`, falling back to {@link DEFAULT_DEAD_MS}.
 *
 * @returns {number}
 */
export function deadThresholdMs() {
  return envInt("OPENCODE_SUBAGENT_DEAD_MS", DEFAULT_DEAD_MS)
}

/**
 * How long (ms) a single in-flight tool call keeps counting as proof of life.
 * Reads `OPENCODE_SUBAGENT_TOOL_GRACE_MS`, falling back to
 * {@link DEFAULT_TOOL_GRACE_MS}.
 *
 * @returns {number}
 */
export function toolGraceThresholdMs() {
  return envInt("OPENCODE_SUBAGENT_TOOL_GRACE_MS", DEFAULT_TOOL_GRACE_MS)
}

/**
 * How long finished/stale/dead records are retained before eviction. Reads
 * `OPENCODE_SUBAGENT_DONE_RETENTION_MS`, falling back to
 * {@link DONE_RETENTION_MS}.
 *
 * @returns {number}
 */
export function doneRetentionMs() {
  return envInt("OPENCODE_SUBAGENT_DONE_RETENTION_MS", DONE_RETENTION_MS)
}

/**
 * Whether a session object represents a child (subagent) session.
 *
 * @param {unknown} info
 * @returns {boolean}
 */
export function isSubagentSession(info) {
  return Boolean(info) && typeof info === "object" && typeof info.parentID === "string" && info.parentID.length > 0
}

/**
 * Start time of the newest in-flight tool call on a record, if any.
 *
 * @param {{ activeTools?: Map<string, { tool: string, startedAt: number }> }} record
 * @returns {number | undefined}
 */
export function newestToolStart(record) {
  const tools = record?.activeTools
  if (!tools || typeof tools.values !== "function") return undefined
  let newest
  for (const entry of tools.values()) {
    if (Number.isFinite(entry?.startedAt) && (newest === undefined || entry.startedAt > newest)) {
      newest = entry.startedAt
    }
  }
  return newest
}

/**
 * Drop in-flight tool entries that can no longer prove the child is alive.
 *
 * A tool part normally emits a terminal state, but a dropped event or a plugin
 * loaded mid-turn can leave a `running` entry behind forever. Pruning at read
 * and write time keeps such an entry from pinning a record at `running` (or
 * reporting `activity: "tool"`) long after the call is over. Idempotent.
 *
 * `toolGraceMs <= 0` disables tool tracking entirely, mirroring the grace-window
 * rule in {@link classifyStatus}.
 *
 * @param {{ activeTools?: Map<string, { startedAt: number }> }} record
 * @param {number} current
 * @param {number} toolGraceMs
 * @returns {void}
 */
export function pruneActiveTools(record, current, toolGraceMs) {
  const tools = record?.activeTools
  if (!tools || typeof tools.delete !== "function") return
  if (!(toolGraceMs > 0)) {
    tools.clear()
    return
  }
  for (const [key, entry] of tools) {
    const startedAt = entry?.startedAt
    if (Number.isFinite(startedAt) && current - startedAt > toolGraceMs) tools.delete(key)
  }
}

/**
 * Newest in-flight tool call on a record, if any.
 *
 * @param {{ activeTools?: Map<string, { tool: string, startedAt: number }> }} record
 * @returns {{ tool: string, startedAt: number } | undefined}
 */
export function newestActiveTool(record) {
  const tools = record?.activeTools
  if (!tools || typeof tools.values !== "function") return undefined
  let newest
  for (const entry of tools.values()) {
    if (Number.isFinite(entry?.startedAt) && (newest === undefined || entry.startedAt > newest.startedAt)) {
      newest = entry
    }
  }
  return newest
}

/**
 * Normalize a message's raw token usage into the TUI's token shape
 * (`{ input, output, reasoning, cache: { read, write } }`), mirroring
 * `src/model.ts` `sessionMetrics` so the sidebar and the tools report identically.
 *
 * @param {object | undefined} tokens
 * @returns {{ input: number, output: number, reasoning: number, cache: { read: number, write: number } } | undefined}
 */
export function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return undefined
  const num = (value) => (Number.isFinite(value) && value > 0 ? value : 0)
  const normalized = {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cache: { read: num(tokens.cache?.read), write: num(tokens.cache?.write) },
  }
  const values = [
    normalized.input,
    normalized.output,
    normalized.reasoning,
    normalized.cache.read,
    normalized.cache.write,
  ]
  return values.some((value) => value > 0) ? normalized : undefined
}

/**
 * Total context tokens used, matching `sessionMetrics` (`used`) in `src/model.ts`:
 * input + output + reasoning + cache read + cache write.
 *
 * @param {{ input: number, output: number, reasoning: number,
 *   cache: { read: number, write: number } } | undefined} tokens
 * @returns {number | undefined}
 */
export function contextUsedOf(tokens) {
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * Snapshot-safe statistics block for a record, merged from event-derived data.
 *
 * Shared by `subagent_status` and `subagent_children` so both render identical
 * numbers without any per-child SDK call.
 *
 * @param {{ stats?: object, lastActivity?: string, lastActivityAt?: number, todos?: object }} record
 * @param {number} [current]
 * @returns {{
 *   model: { providerID?: string, modelID?: string } | undefined,
 *   tokens: object | undefined,
 *   contextLimit: number | undefined,
 *   contextUsed: number | undefined,
 *   contextPercent: number | null,
 *   toolCalls: number,
 *   toolErrors: number,
 *   toolCounts: Record<string, number>,
 *   lastTool: object | undefined,
 *   todo: object | null,
 *   lastActivity: string | undefined,
 *   lastActivityAt: number | undefined,
 *   sinceLastActivityMs: number | undefined,
 * }}
 */
export function summarizeStats(record, current) {
  const stats = record?.stats ?? {}
  const tokens = stats.tokens
  const contextUsed = contextUsedOf(tokens)
  const limit = Number.isFinite(stats.contextLimit) && stats.contextLimit > 0 ? stats.contextLimit : undefined
  const lastActivityAt = Number.isFinite(record?.lastActivityAt) ? record.lastActivityAt : undefined
  return {
    model: stats.model,
    tokens,
    contextLimit: limit,
    contextUsed,
    // Never fabricate a percentage when the limit is unknown.
    contextPercent: contextUsed !== undefined && limit ? Math.round((contextUsed / limit) * 100) : null,
    toolCalls: Number.isFinite(stats.toolCalls) ? stats.toolCalls : 0,
    toolErrors: Number.isFinite(stats.toolErrors) ? stats.toolErrors : 0,
    toolCounts: stats.toolCounts ?? {},
    lastTool: stats.lastTool,
    todo: record?.todos ?? null,
    lastActivity: record?.lastActivity,
    lastActivityAt,
    sinceLastActivityMs:
      lastActivityAt !== undefined && Number.isFinite(current) ? Math.max(0, current - lastActivityAt) : undefined,
  }
}

/**
 * Newest evidence that the child did work: the progress clock or the start of
 * an in-flight tool call, whichever is later.
 *
 * When a record somehow lacks `lastProgressAt` the fallback is `startedAt`, a
 * safe lower bound. Never `lastEventAt`: that clock advances on weak events, so
 * falling back to it would resurrect the zombie-`running` bug for exactly the
 * records that are hardest to classify.
 *
 * @param {{ lastProgressAt?: number, startedAt?: number, activeTools?: Map<string, { startedAt: number }> }} record
 * @returns {number}
 */
export function progressEvidenceAt(record) {
  let at = Number.isFinite(record?.lastProgressAt) ? record.lastProgressAt : record?.startedAt
  const toolStart = newestToolStart(record)
  if (Number.isFinite(toolStart) && (!Number.isFinite(at) || toolStart > at)) at = toolStart
  return at
}

/**
 * Classify a tracked record into its reported status.
 *
 * Terminal lifecycle states win. Then an in-flight tool call younger than
 * `toolGraceMs` returns `running` regardless of how old the last progress is —
 * a long build is not a zombie. Otherwise the age is measured against the
 * newest progress evidence (never the bookkeeping event clock).
 *
 * `deadMs <= 0` disables the dead tier, `staleMs <= 0` disables the stale tier,
 * and `toolGraceMs <= 0` disables the tool-call grace window.
 *
 * @param {{ status: string, lastProgressAt?: number, lastEventAt?: number,
 *   activeTools?: Map<string, { startedAt: number }> }} record
 * @param {number} now
 * @param {number} staleMs
 * @param {number} [deadMs]
 * @param {number} [toolGraceMs]
 * @returns {"running" | "done" | "error" | "stale" | "dead"}
 */
export function classifyStatus(record, now, staleMs, deadMs = 0, toolGraceMs = DEFAULT_TOOL_GRACE_MS) {
  if (record.status === "error") return "error"
  if (record.status === "done") return "done"
  pruneActiveTools(record, now, toolGraceMs)
  const toolStart = newestToolStart(record)
  if (toolStart !== undefined && toolGraceMs > 0 && now - toolStart <= toolGraceMs) return "running"
  const age = now - progressEvidenceAt(record)
  if (deadMs > 0 && age > deadMs) return "dead"
  if (staleMs > 0 && age > staleMs) return "stale"
  return "running"
}

// Rendering helpers are shared with every other subagent module; re-exported
// here so a caller that imports liveness maths gets its formatter too.
export { formatDuration } from "./subagent-format.js"

/** Compact age label used in the tool-call hint (`30s`, `7m`, `1h 5m`). */
function formatToolAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return `${seconds}s`
}

/**
 * Sort priority for reported statuses. Live work sorts first.
 *
 * Aliases the single canonical table in {@link ./subagent-format.js}, so
 * `subagent_status` and `subagent_children` cannot drift apart. The export name
 * is kept for callers that import it from this module.
 */
export const STATUS_RANK = STATUS_ORDER

/**
 * Observable activity of a record: `tool` while a tool call is in flight,
 * `streaming` when progress advanced within the stale window and the child is
 * still live, else `idle`.
 *
 * Terminal states are checked FIRST. A finished child with a leftover tool
 * entry must read `idle`, not `tool`: otherwise `counts.working` includes it and
 * `report()` keeps describing a completed child as if it were running.
 *
 * @param {{ status?: string, lastProgressAt: number, activeTools?: Map<string, unknown> }} record
 * @param {number} current
 * @param {number} staleMs
 * @returns {"tool" | "streaming" | "idle"}
 */
export function activityOf(record, current, staleMs) {
  if (record.status === "done" || record.status === "error") return "idle"
  if (newestToolStart(record) !== undefined) return "tool"
  const window = staleMs > 0 ? staleMs : 0
  if (current - record.lastProgressAt <= window) return "streaming"
  return "idle"
}

/**
 * Actionable next step for a non-terminal child, or `undefined` when the status
 * needs no intervention. A long in-flight tool call is called out as expected
 * rather than as a reason to cancel.
 *
 * @param {object} item
 * @param {number} toolGraceMs
 * @returns {string | undefined}
 */
export function hintFor(item, toolGraceMs) {
  if (item.status === "done" || item.status === "error") return undefined
  if (item.activity === "tool" && item.activeTool && item.activeTool.runningMs <= toolGraceMs) {
    return (
      `running tool ${JSON.stringify(item.activeTool.tool)} for ${formatToolAge(item.activeTool.runningMs)} ` +
      `— expected for a long build, not stale`
    )
  }
  const age = formatDuration(item.sinceLastProgressMs)
  if (item.status === "stale") return `no progress for ${age} — consider subagent_result or subagent_cancel`
  if (item.status === "dead") return `no progress for ${age} — likely dead, cancel and re-dispatch`
  if (item.status === "running") return `working (last progress ${age} ago)`
  return undefined
}

/**
 * Build the classified snapshot item for one record.
 *
 * A report item is the read-only projection both tools render: the derived
 * status plus every counter, clock, and identity field a caller may want. It
 * performs no I/O, so it is safe to call from `report()` on every invocation.
 *
 * @param {object} record
 * @param {number} current
 * @param {number} staleMs
 * @param {number} deadMs
 * @param {number} graceMs
 * @returns {object}
 */
export function buildItem(record, current, staleMs, deadMs, graceMs) {
  const status = classifyStatus(record, current, staleMs, deadMs, graceMs)
  const terminal = status === "done" || status === "error"
  // A terminal record has no in-flight work: never report one, so `working`
  // counts stay honest even if a leftover tool entry survived.
  const active = terminal ? undefined : newestActiveTool(record)
  const activeTool = active ? { tool: active.tool, runningMs: Math.max(0, current - active.startedAt) } : null
  const evidenceAt =
    terminal && Number.isFinite(record.lastProgressAt) ? record.lastProgressAt : progressEvidenceAt(record)
  const stats = summarizeStats(record, current)
  return {
    sessionID: record.sessionID,
    parentID: record.parentID,
    title: record.title,
    slug: record.slug,
    agent: record.agent,
    status,
    stale: status === "stale",
    dead: status === "dead",
    activity: activityOf(record, current, staleMs),
    activeTool,
    lastStatusType: record.lastStatusType,
    startedAt: record.startedAt,
    lastEventAt: record.lastEventAt,
    lastProgressAt: record.lastProgressAt,
    doneAt: record.doneAt,
    elapsedMs: Math.max(0, current - record.startedAt),
    sinceLastEventMs: Math.max(0, current - record.lastEventAt),
    // Measured from the newest evidence (including an in-flight tool start) so
    // a long tool call is not reported as a runaway idle gap.
    sinceLastProgressMs: Math.max(0, current - evidenceAt),
    model: stats.model,
    tokens: stats.tokens,
    contextLimit: stats.contextLimit,
    contextUsed: stats.contextUsed,
    contextPercent: stats.contextPercent,
    toolCalls: stats.toolCalls,
    toolErrors: stats.toolErrors,
    toolCounts: stats.toolCounts,
    lastTool: stats.lastTool,
    todo: stats.todo,
    lastActivity: stats.lastActivity,
    lastActivityAt: stats.lastActivityAt,
    sinceLastActivityMs: stats.sinceLastActivityMs,
  }
}


/** Aggregate per-status counts over a snapshot, plus the total and in-flight count. */
export function countByStatus(items) {
  return {
    total: items.length,
    running: items.filter((item) => item.status === "running").length,
    done: items.filter((item) => item.status === "done").length,
    error: items.filter((item) => item.status === "error").length,
    stale: items.filter((item) => item.status === "stale").length,
    dead: items.filter((item) => item.status === "dead").length,
    working: items.filter((item) => item.activeTool !== null).length,
  }
}

/**
 * Build the plain-text body of the `subagent_status` tool result.
 *
 * Reuses the shared triage renderer so `subagent_status` and
 * `subagent_children` read identically, with this tool's richer
 * threshold-aware hint on the first line.
 *
 * @param {object[]} items
 * @param {object} summary
 * @param {{ staleMs: number, deadMs: number, toolGraceMs: number }} thresholds
 * @returns {string}
 */
export function formatReport(items, summary, thresholds) {
  const { staleMs, deadMs, toolGraceMs } = thresholds
  if (items.length === 0) {
    return (
      `No background subagents tracked (stale threshold ${formatDuration(staleMs)}, ` +
      `dead threshold ${formatDuration(deadMs)}).`
    )
  }
  const header = `${renderChildHeader(items)} (stale ${formatDuration(staleMs)}, dead ${formatDuration(deadMs)})`
  const lines = []
  for (const item of items) {
    lines.push(
      ...renderChildLines([item], { verbose: true, staleHint: false, hint: (row) => hintFor(row, toolGraceMs) }),
    )
  }
  return [header, ...lines].join("\n")
}
