/**
 * Child-row construction and activity rendering for the subagent control tools.
 *
 * `subagent_children` and `subagent_status` must describe the same child the
 * same way, and `subagent_result`'s activity view must agree with both. This
 * module owns that projection: SDK status mapping, the registry-preferred row
 * builder, aggregate counts, and the plain-text activity report.
 *
 * Everything here is pure or takes injected `client`/`registry`/`now`, so it is
 * unit-testable without the OpenCode runtime and never throws on missing SDK
 * methods.
 *
 * @module subagent-rows
 */

import { unwrap } from "./subagent-utils.js"
import { clampText } from "./subagent-summarize.js"
import { formatDuration, formatTokens, usedTokens } from "./subagent-format.js"

/** Default number of children a list renders before truncating. */
export const DEFAULT_CHILDREN_LIMIT = 20

/**
 * Map an SDK session status type onto the registry lifecycle vocabulary.
 *
 * @param {string | undefined} type
 * @returns {"running" | "done" | "error" | "unknown"}
 */
export function mapSdkStatus(type) {
  if (type === "busy" || type === "retry") return "running"
  if (type === "idle") return "done"
  if (type === "error") return "error"
  return "unknown"
}

/**
 * Pick the mapped lifecycle status for a session from a status map.
 *
 * An unknown session is `unknown`, NOT `idle`: claiming a session is idle when
 * the SDK never reported it is exactly how `subagent_children` disagreed with
 * `subagent_status`.
 *
 * @param {Record<string, { type?: string }>} statusMap
 * @param {string} sessionID
 * @returns {{ type: string }}
 */
export function pickStatus(statusMap, sessionID) {
  const status = statusMap && typeof statusMap === "object" ? statusMap[sessionID] : undefined
  if (!status || typeof status.type !== "string") return { type: "unknown" }
  return { type: mapSdkStatus(status.type) }
}

/**
 * Read the SDK session status map, tolerating a missing `status` method.
 *
 * Listing children needs the status map to classify untracked children; a build
 * without `session.status` simply yields `{}` and those rows read `unknown`.
 *
 * @param {object} api
 * @returns {Promise<Record<string, { type?: string }>>}
 */
export async function readStatusMap(api) {
  if (typeof api?.status !== "function") return {}
  try {
    const map = unwrap(await api.status())
    return map && typeof map === "object" ? map : {}
  } catch {
    return {}
  }
}

/** Render an error thrown by an SDK call into a short string. */
export function errorText(error) {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error?.message ?? error)
}

// Rendering helpers live in `./subagent-format.js`; re-exported for callers of
// this module's row/activity helpers.
export { formatDuration } from "./subagent-format.js"

/** Context percentage, or `null` when the limit is unknown. */
export function percentOf(tokens, limit) {
  const used = usedTokens(tokens)
  if (used === undefined || !Number.isFinite(limit) || limit <= 0) return null
  return Math.round((used / limit) * 100)
}

/** Aggregate a row list into per-status counts plus a total. */
export function countRows(rows) {
  const counts = { total: rows.length }
  for (const row of rows) {
    const status = row.status ?? "unknown"
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/** Elapsed milliseconds since an SDK timestamp, or `undefined` when unknown. */
export function elapsedFrom(startedAt, current) {
  if (!Number.isFinite(startedAt)) return undefined
  return Math.max(0, current - startedAt)
}

/**
 * Merge registry facts into an SDK-derived activity summary.
 *
 * The registry and the SDK see different things: the registry knows a tool call
 * is in flight (it saw the `tool` part event) and holds the latest todo, while
 * the SDK message list is what was persisted. When `session.messages` comes back
 * empty or behind, one source alone produces a report that contradicts its own
 * metadata ("no tool call in flight" next to `activeTool: bash`). Filling the
 * gaps keeps the text and the metadata telling the same story.
 *
 * @param {object} summary result of `summarizeActivity`
 * @param {{ activeTool?: object | null, todo?: object | null, lastActivity?: string,
 *   lastActivityAt?: number, sinceLastActivityMs?: number, stats?: object }} tracked
 * @returns {object}
 */
export function mergeActivity(summary, tracked) {
  if (!tracked) return summary
  const inFlight =
    summary.inFlight.length > 0
      ? summary.inFlight
      : tracked.activeTool
        ? [{ tool: tracked.activeTool.tool, startedAt: 0, runningMs: tracked.activeTool.runningMs }]
        : []
  return {
    ...summary,
    inFlight,
    todos: summary.todos ?? tracked.todo ?? null,
    lastActivity: summary.lastActivity ?? tracked.lastActivity,
    lastActivityAt: summary.lastActivityAt ?? tracked.lastActivityAt,
    sinceLastActivityMs: summary.sinceLastActivityMs ?? tracked.sinceLastActivityMs,
    stats: summary.stats ?? tracked.stats,
  }
}

/**
 * Render an activity summary as short readable text.
 *
 * This is the "what is it doing" answer: in-flight tool with elapsed time,
 * current todo, latest text, last error, cost, and message counts. A child with
 * no recorded activity says so instead of pretending to work.
 *
 * @param {string} sessionID
 * @param {object} summary result of `summarizeActivity`
 * @param {string} status classified lifecycle status
 * @returns {string}
 */
export function formatActivity(sessionID, summary, status) {
  const working = summary.inFlight.length > 0 || summary.lastActivity !== undefined
  const parts = [working ? `${sessionID} is working.` : `${sessionID} has no recorded activity yet (status ${status}).`]
  if (summary.inFlight.length > 0) {
    const tools = summary.inFlight.map((entry) => `${entry.tool} for ${formatDuration(entry.runningMs)}`)
    parts.push(`In flight: ${tools.join(", ")}.`)
  } else {
    parts.push("No tool call in flight.")
  }
  if (summary.todos) {
    const current = summary.todos.current ? `, current: ${JSON.stringify(summary.todos.current)}` : ""
    parts.push(
      `Todos: ${summary.todos.completed}/${summary.todos.total} done, ` +
        `${summary.todos.inProgress} in progress${current}.`,
    )
  }
  if (summary.lastText) parts.push(`Latest: ${clampText(summary.lastText, 300)}`)
  if (summary.lastError) parts.push(`[error] ${errorText(summary.lastError)}`)
  if (summary.lastActivity) {
    const age = Number.isFinite(summary.sinceLastActivityMs)
      ? ` ${formatDuration(summary.sinceLastActivityMs)} ago`
      : ""
    parts.push(`Last activity: ${summary.lastActivity}${age}.`)
  }

  // Cost line, using the same token shape the TUI reports.
  const stats = summary.stats ?? {}
  const used = usedTokens(stats.tokens)
  const limit = Number.isFinite(stats.contextLimit) && stats.contextLimit > 0 ? stats.contextLimit : undefined
  if (used !== undefined) {
    const share = limit ? `/${formatTokens(limit)} (${Math.round((used / limit) * 100)}%)` : ""
    parts.push(`Context: ${formatTokens(used)}${share}.`)
  }
  if (stats.model) parts.push(`Model: ${stats.model.providerID} / ${stats.model.modelID}.`)

  const { counts } = summary
  const tools = `${counts.toolCalls} tool call(s)${counts.toolErrors ? `, ${counts.toolErrors} failed` : ""}`
  parts.push(`Messages: ${counts.messages} (${counts.assistant} assistant, ${counts.user} user), ${tools}.`)
  return parts.join("\n")
}

/**
 * Build the row builders used by the control tools.
 *
 * A row prefers the registry (which has event-derived stats and a classified
 * status) and falls back to the SDK session object plus one status map read. It
 * never fetches per-child messages, so listing N children stays O(1) SDK calls.
 *
 * @param {{
 *   registry?: { get: (sessionID: string) => object | undefined },
 *   now: () => number,
 * }} context
 * @returns {{
 *   sdkRow: (info: object, statusMap: Record<string, { type?: string }>) => object,
 *   registryRow: (item: object) => object,
 * }}
 */
export function createRowBuilders({ registry, now }) {
  /** Registry item for a session, or `undefined` when untracked. */
  function tracked(sessionID) {
    if (!registry || typeof registry.get !== "function") return undefined
    return registry.get(sessionID)
  }

  /** Build a child row from an SDK session object (one `children`+`status` read). */
  function sdkRow(info, statusMap) {
    const item = tracked(info.id)
    const sdkStatus = pickStatus(statusMap, info.id).type
    const rawSdk = statusMap && typeof statusMap === "object" ? statusMap[info.id]?.type : undefined
    const status = item ? item.status : sdkStatus
    const source = item ? "registry" : sdkStatus !== "unknown" ? "sdk" : "unknown"
    return {
      sessionID: info.id,
      title: info.title,
      parentID: info.parentID,
      directory: info.directory,
      slug: item?.slug ?? info.slug,
      agent: item?.agent ?? info.agent,
      status,
      sdkStatus: typeof rawSdk === "string" ? rawSdk : undefined,
      source,
      startedAt: item?.startedAt ?? info.time?.created,
      elapsedMs: item?.elapsedMs ?? elapsedFrom(info.time?.created, now()),
      updated: info.time?.updated,
      stale: item ? Boolean(item.stale) : status === "stale",
      dead: item ? Boolean(item.dead) : status === "dead",
      activity: item?.activity ?? null,
      activeTool: item?.activeTool ?? null,
      todo: item?.todo ?? null,
      sinceLastProgressMs: item?.sinceLastProgressMs ?? null,
      sinceLastEventMs: item?.sinceLastEventMs ?? null,
      sinceLastActivityMs: item?.sinceLastActivityMs,
      lastActivity: item?.lastActivity,
      lastActivityAt: item?.lastActivityAt,
      model: item?.model,
      tokens: item?.tokens,
      contextUsed: item?.contextUsed,
      contextPercent: item?.contextPercent,
      contextLimit: item?.contextLimit,
      toolCalls: item?.toolCalls,
      toolErrors: item?.toolErrors,
      toolCounts: item?.toolCounts,
    }
  }

  /** Build a child row from a registry snapshot item (no SDK call at all). */
  function registryRow(item) {
    return {
      sessionID: item.sessionID,
      title: item.title,
      parentID: item.parentID,
      directory: undefined,
      slug: item.slug,
      agent: item.agent,
      status: item.status,
      sdkStatus: item.lastStatusType,
      source: "registry",
      startedAt: item.startedAt,
      elapsedMs: item.elapsedMs,
      updated: item.lastEventAt,
      stale: Boolean(item.stale),
      dead: Boolean(item.dead),
      activity: item.activity,
      activeTool: item.activeTool,
      todo: item.todo ?? null,
      sinceLastProgressMs: item.sinceLastProgressMs,
      sinceLastEventMs: item.sinceLastEventMs,
      sinceLastActivityMs: item.sinceLastActivityMs,
      lastActivity: item.lastActivity,
      lastActivityAt: item.lastActivityAt,
      model: item.model,
      tokens: item.tokens,
      contextUsed: item.contextUsed,
      contextPercent: item.contextPercent,
      contextLimit: item.contextLimit,
      toolCalls: item.toolCalls,
      toolErrors: item.toolErrors,
      toolCounts: item.toolCounts,
    }
  }

  return { sdkRow, registryRow }
}
