/**
 * Pure transcript helpers for the background-subagent control tools.
 *
 * These read the message list OpenCode already returns from
 * `session.messages(...)` and turn it into something a parent can act on:
 *
 *   - `summarizeActivity` — what the child is doing RIGHT NOW (in-flight tool
 *     calls, the todo it is on, its latest text), so a still-running child is
 *     informative instead of a dead end.
 *   - `summarizeHistory`  — a compact chronological transcript.
 *   - `extractResult`     — the final assistant answer (unchanged).
 *
 * Nothing here performs I/O or throws on malformed input: the shapes come from
 * the SDK and are treated as untrusted data.
 *
 * @module subagent-summarize
 */

/** Characters kept for the "latest text" snippet in an activity summary. */
export const ACTIVITY_TEXT_CHARS = 600

/** Characters kept per line in a history transcript. */
export const HISTORY_LINE_CHARS = 200

/** Characters kept for a tool-call argument summary. */
export const HISTORY_ARGS_CHARS = 120

/** Default number of messages rendered by `summarizeHistory`. */
export const DEFAULT_HISTORY_LIMIT = 20

/** Default total character budget for `summarizeHistory`. */
export const DEFAULT_HISTORY_CHARS = 4000

/**
 * Clamp a string to `max` characters, appending a marker when truncated.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clampText(text, max) {
  const value = String(text ?? "")
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value
  const marker = `\n…[truncated ${value.length - max} chars]`
  if (marker.length >= max) return value.slice(0, max)
  return value.slice(0, max - marker.length) + marker
}

/** Text parts that are real answers, not injected prompts or instructions. */
export function isAnswerPart(part) {
  return part && part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true
}

/**
 * Extract the final assistant answer from a session's message list.
 *
 * Walks messages from newest to oldest and returns the last non-synthetic text
 * part of the newest assistant message. Also surfaces a terminal error and the
 * finish reason when present.
 *
 * @param {Array<{ info?: object, parts?: Array<object> }>} messages
 * @returns {{ text: string, error: unknown, finish: unknown, messageID: string | undefined, found: boolean }}
 */
export function extractResult(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]
    const info = entry?.info
    if (!info || info.role !== "assistant") continue
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    const texts = parts.filter(isAnswerPart).map((part) => part.text)
    return {
      text: texts.join("\n").trim(),
      error: info.error,
      finish: info.finish,
      messageID: info.id,
      found: texts.length > 0,
    }
  }
  return { text: "", error: undefined, finish: undefined, messageID: undefined, found: false }
}

/**
 * Slice a message list to only the entries AFTER `sinceMessageID`.
 *
 * Used as a read cursor so a caller can poll without re-reading the whole
 * answer. An unknown cursor (or none) leaves the list untouched.
 *
 * @param {Array<{ info?: { id?: string } }>} messages
 * @param {string | undefined} sinceMessageID
 * @returns {Array<{ info?: { id?: string } }>}
 */
export function sliceAfterCursor(messages, sinceMessageID) {
  const list = Array.isArray(messages) ? messages : []
  if (typeof sinceMessageID !== "string" || !sinceMessageID) return list
  const index = list.findIndex((entry) => entry?.info?.id === sinceMessageID)
  return index === -1 ? list : list.slice(index + 1)
}

/**
 * Count todos by status and surface the item currently in progress.
 *
 * Shared with the status registry, which caches this on every `todo.updated`
 * event so `subagent_status`/`subagent_children` can report todo progress
 * without any extra SDK call.
 *
 * @param {unknown} todos
 * @returns {{ total: number, completed: number, inProgress: number, pending: number, current?: string } | null}
 */
export function summarizeTodos(todos) {
  if (!Array.isArray(todos)) return null
  const summary = { total: todos.length, completed: 0, inProgress: 0, pending: 0, current: undefined }
  for (const todo of todos) {
    const status = todo?.status
    if (status === "completed") summary.completed += 1
    else if (status === "in_progress") {
      summary.inProgress += 1
      if (!summary.current && typeof todo?.content === "string") summary.current = clampText(todo.content, 80)
    } else if (status === "pending") summary.pending += 1
  }
  return summary
}

/**
 * Describe what a child session is doing right now.
 *
 * Reads the SDK message list only: in-flight tool calls (with elapsed time), the
 * newest assistant text, the newest error, the latest todo state, message
 * counts, and the most recent timestamp. A still-running child therefore has a
 * real answer ("running bash for 7m, todo 2/5 in progress") instead of "no
 * assistant answer found".
 *
 * @param {Array<{ info?: object, parts?: Array<object> }>} messages
 * @param {{ now?: number | (() => number), stats?: object }} [options]
 * @returns {{
 *   inFlight: Array<{ tool: string, startedAt: number, runningMs: number }>,
 *   lastText: string,
 *   lastRole: string | undefined,
 *   lastError: unknown,
 *   todos: { total: number, completed: number, inProgress: number, pending: number, current?: string } | null,
 *   counts: { messages: number, assistant: number, user: number, toolCalls: number, toolErrors: number },
 *   lastActivityAt: number | undefined,
 *   lastActivity: string | undefined,
 *   sinceLastActivityMs: number | undefined,
 *   stats: object | undefined,
 * }}
 */
export function summarizeActivity(messages, options = {}) {
  const clock = options.now
  const now = typeof clock === "function" ? clock() : Number.isFinite(clock) ? clock : Date.now()
  const list = Array.isArray(messages) ? messages : []
  const inFlight = []
  const counts = { messages: list.length, assistant: 0, user: 0, toolCalls: 0, toolErrors: 0 }
  const toolCounts = {}
  const seenToolCalls = new Set()
  const erroredCalls = new Set()
  let lastText = ""
  let lastRole
  let lastError
  let lastActivityAt
  let lastActivity
  let todosRaw
  let statsTokens
  let statsModel
  let statsLimit

  /** Track the newest timestamp seen across messages and parts. */
  const bump = (value) => {
    if (Number.isFinite(value) && (lastActivityAt === undefined || value > lastActivityAt)) lastActivityAt = value
  }

  for (const entry of list) {
    const info = entry?.info
    const parts = Array.isArray(entry?.parts) ? entry.parts : []
    if (info) {
      if (info.role === "assistant") counts.assistant += 1
      else if (info.role === "user") counts.user += 1
      if (typeof info.role === "string") lastRole = info.role
      if (info.error) lastError = info.error
      bump(info.time?.completed)
      bump(info.time?.created)
      if (info.role === "assistant") {
        // Latest assistant message wins (never summed across messages).
        if (info.tokens) statsTokens = info.tokens
        const providerID = info.providerID ?? info.model?.providerID
        const modelID = info.modelID ?? info.model?.id ?? info.model?.modelID
        if (typeof providerID === "string" && typeof modelID === "string" && providerID && modelID) {
          statsModel = { providerID, modelID }
        }
        const limit = info.model?.limit?.context ?? info.limit?.context
        if (Number.isFinite(limit) && limit > 0) statsLimit = limit
        if (parts.some((part) => isAnswerPart(part))) lastActivity = "streaming"
      }
    }
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      if (part.type === "tool") {
        const status = part.state?.status
        const startedAt = Number.isFinite(part.state?.time?.start) ? part.state.time.start : undefined
        const tool = part.tool ?? "tool"
        const key = part.callID ?? part.id
        bump(startedAt)
        bump(part.state?.time?.end)
        // Count each call once by its call id: parts re-emit per state change.
        if (!key || !seenToolCalls.has(key)) {
          if (key) seenToolCalls.add(key)
          counts.toolCalls += 1
          toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
        }
        if (status === "error" && (!key || !erroredCalls.has(key))) {
          if (key) erroredCalls.add(key)
          counts.toolErrors += 1
        }
        if (status === "running" || status === "pending") {
          const start = startedAt ?? now
          inFlight.push({ tool, startedAt: start, runningMs: Math.max(0, now - start) })
        }
        if (part.tool === "todowrite" && Array.isArray(part.state?.input?.todos)) todosRaw = part.state.input.todos
        lastActivity = `tool:${tool}`
      } else if (part.type === "todo" && Array.isArray(part.todos)) {
        todosRaw = part.todos
        if (!lastActivity) lastActivity = "todo"
      }
      // Newest assistant text wins: the loop runs in chronological order.
      if (info?.role === "assistant" && isAnswerPart(part)) lastText = part.text
    }
  }

  return {
    inFlight,
    lastText: clampText(lastText, ACTIVITY_TEXT_CHARS),
    lastRole,
    lastError,
    todos: summarizeTodos(todosRaw),
    counts,
    lastActivityAt,
    lastActivity,
    sinceLastActivityMs: lastActivityAt !== undefined ? Math.max(0, now - lastActivityAt) : undefined,
    stats: {
      toolCalls: counts.toolCalls,
      toolErrors: counts.toolErrors,
      toolCounts,
      tokens: statsTokens,
      model: statsModel,
      contextLimit: statsLimit,
    },
  }
}

/** Collapse a value into a single-line, length-bounded summary. */
function oneLine(value, max) {
  const text = typeof value === "string" ? value : safeJson(value)
  return clampText(String(text ?? "").replace(/\s+/g, " ").trim(), max)
}

/** JSON-stringify without throwing on cycles or exotic values. */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/** Render one message entry as history lines (message first, then its tools). */
function historyLines(entry) {
  const info = entry?.info
  const parts = Array.isArray(entry?.parts) ? entry.parts : []
  const lines = []
  for (const part of parts) {
    if (!part || typeof part !== "object" || part.synthetic === true || part.ignored === true) continue
    if (part.type === "text" && typeof part.text === "string") {
      const role = info?.role === "user" ? "user" : "assistant"
      lines.push(`[${role}] ${oneLine(part.text, HISTORY_LINE_CHARS)}`)
      continue
    }
    if (part.type !== "tool") continue
    const tool = part.tool ?? "tool"
    const status = part.state?.status
    lines.push(`  → ${tool} ${oneLine(part.state?.input, HISTORY_ARGS_CHARS)}`)
    if (status === "completed" || status === "error") {
      const detail = status === "error" ? part.state?.error ?? "error" : part.state?.output ?? part.state?.title ?? ""
      lines.push(`  ← ${tool} ${status === "error" ? "error" : "ok"} ${oneLine(detail, HISTORY_ARGS_CHARS)}`)
    }
  }
  return lines
}

/**
 * Render a compact chronological transcript of a child session.
 *
 * One `[role] text` line per text part and `→ tool` / `← tool ok|error` lines
 * per tool call. Synthetic and ignored parts are skipped. Defaults to the LAST
 * `limit` messages (clamped 1..100) and to the newest lines fitting `maxChars`.
 *
 * @param {Array<{ info?: object, parts?: Array<object> }>} messages
 * @param {{ limit?: number, maxChars?: number, sinceMessageID?: string }} [options]
 * @returns {string}
 */
export function summarizeHistory(messages, options = {}) {
  const rawLimit = Number(options.limit)
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : DEFAULT_HISTORY_LIMIT
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : DEFAULT_HISTORY_CHARS
  const windowed = sliceAfterCursor(messages, options.sinceMessageID)
  const entries = windowed.slice(-limit)
  const lines = []
  for (const entry of entries) lines.push(...historyLines(entry))

  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  let start = 0
  while (start < lines.length - 1 && total > maxChars) {
    total -= lines[start].length + 1
    start += 1
  }
  const selected = lines.slice(start)
  if (start > 0) selected.unshift(`…[${start} earlier line(s) omitted]`)
  return selected.join("\n")
}
