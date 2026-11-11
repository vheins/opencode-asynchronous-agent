/**
 * Shared rendering for the background-subagent tools.
 *
 * `subagent_status` and `subagent_children` must report the same child the same
 * way, so the glyph vocabulary, duration/token formatting, and the two-line
 * child layout live here once.
 *
 * Token formatting mirrors the TUI (`src/model.ts` `sessionMetrics`): tokens are
 * `{ input, output, reasoning, cache: { read, write } }`, "used" is the sum of
 * all five, and a context percentage is only printed when the limit is known.
 *
 * @module subagent-format
 */

/** Glyph per reported status, matching the TUI vocabulary. */
export const STATUS_GLYPH = {
  running: "●",
  stale: "◐",
  dead: "✕",
  error: "✕",
  done: "✓",
  unknown: "?",
}

/**
 * Canonical triage order shared by every subagent tool: live work first, then
 * work needing attention, then finished work, unknown last.
 */
export const STATUS_ORDER = { running: 0, stale: 1, dead: 2, error: 3, done: 4, unknown: 5 }

/**
 * Sort priority for a status; unknown statuses sort last.
 *
 * @param {string} status
 * @returns {number}
 */
export function statusRank(status) {
  return STATUS_ORDER[status] ?? STATUS_ORDER.unknown
}

/**
 * Glyph for a status; an unrecognized status renders as the unknown glyph.
 *
 * @param {string} status
 * @returns {string}
 */
export function statusGlyph(status) {
  return STATUS_GLYPH[status] ?? STATUS_GLYPH.unknown
}

/**
 * Render a millisecond duration as a compact triage label: `4m12s`, `12m04s`,
 * `1h05m`, `38s`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatShortDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000)
  const seconds = Math.floor(total % 60)
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

/**
 * Render a millisecond duration as a human-readable label with explicit units:
 * `0m 0s`, `1m 1s`, `1h 1m 1s`. Used where the reader needs the exact elapsed
 * time (status reports, activity lines); triage rows use {@link formatShortDuration}.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : `${minutes}m ${seconds % 60}s`
}

/**
 * Render a token count with a `k`/`M` suffix: `987`, `12.3k`, `200k`, `1.24M`.
 *
 * Whole thousands/millions drop the trailing decimal so a contract limit reads
 * `200k`, not `200.0k`.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
  const n = Number(value) || 0
  /** Drop trailing zeros so a whole number reads `200k`, not `200.0k`. */
  const trim = (text) => text.replace(/\.?0+$/, "")
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(2))}M`
  if (n >= 1_000) return `${trim((n / 1_000).toFixed(1))}k`
  return String(Math.round(n))
}

/** Total tokens used, mirroring the TUI's `used` (sum of every token bucket). */
export function usedTokens(tokens) {
  if (!tokens) return undefined
  const values = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ]
  if (!values.some((value) => Number.isFinite(value) && value > 0)) return undefined
  return values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0)
}

/** Compact agent label: lowercase, spaces collapsed to `-`, bounded length. */
function shortAgent(agent) {
  if (typeof agent !== "string" || !agent) return undefined
  return agent.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 18)
}

/** Render the identity segment of a child row (`agent · slug · "title"`). */
function identityOf(row) {
  const parts = []
  const agent = shortAgent(row.agent)
  if (agent) parts.push(agent)
  if (row.slug) parts.push(row.slug)
  if (row.title) parts.push(JSON.stringify(row.title))
  return parts.join(" · ")
}

/** Render the activity segment of a child's detail line. */
function activityOf(row) {
  if (row.activeTool) return `tool:${row.activeTool.tool} ${formatShortDuration(row.activeTool.runningMs)}`
  if (row.activity === "streaming") return "streaming"
  if (row.status === "stale" || row.status === "dead") {
    if (Number.isFinite(row.sinceLastProgressMs)) {
      return `no progress ${formatShortDuration(row.sinceLastProgressMs)}`
    }
  }
  return undefined
}

/** Render the todo segment (`todo 2/5`). */
function todoOf(row) {
  const todo = row.todo
  if (!todo || !Number.isFinite(todo.total) || todo.total <= 0) return undefined
  return `todo ${todo.completed}/${todo.total}`
}

/** Render the cost segment (`12.3k/200k ctx 6%`, or `12.3k ctx` without a limit). */
function costOf(row) {
  const used = usedTokens(row.tokens)
  if (used === undefined) return undefined
  if (Number.isFinite(row.contextLimit) && row.contextLimit > 0) {
    const percent = Number.isFinite(row.contextPercent) ? row.contextPercent : Math.round((used / row.contextLimit) * 100)
    return `${formatTokens(used)}/${formatTokens(row.contextLimit)} ctx ${percent}%`
  }
  return `${formatTokens(used)} ctx`
}

/** Render the tool-call segment (`8 calls (1 err)`, `1 call`). */
function callsOf(row) {
  if (!Number.isFinite(row.toolCalls) || row.toolCalls <= 0) return undefined
  const noun = row.toolCalls === 1 ? "call" : "calls"
  return row.toolErrors > 0 ? `${row.toolCalls} ${noun} (${row.toolErrors} err)` : `${row.toolCalls} ${noun}`
}

/** Per-tool breakdown for verbose mode (`bash×5 edit×3`). */
function toolBreakdown(row) {
  const counts = row.toolCounts
  if (!counts || typeof counts !== "object") return undefined
  const entries = Object.entries(counts)
  if (entries.length === 0) return undefined
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(" ")
}

/** Whether the row should carry an actionable hint (stale/dead only). */
function hintOf(row, staleHint) {
  if (!staleHint) return undefined
  if (row.status === "stale" || row.status === "dead") return "→ subagent_cancel or subagent_result"
  return undefined
}

/**
 * Render child rows as an aligned, triage-friendly block.
 *
 * One line per child carries identity and status; a second detail line appears
 * only when there is detail to show. Unknown segments are omitted rather than
 * padded with placeholders. Column widths are recomputed for every call.
 *
 * `hint` lets a caller supply its own per-row actionable suffix (the status tool
 * has richer wording); it defaults to the stale/dead cancel hint.
 *
 * @param {Array<object>} rows
 * @param {{ verbose?: boolean, staleHint?: boolean, hint?: (row: object) => string | undefined }} [options]
 * @returns {string[]}
 */
export function renderChildLines(rows, options = {}) {
  const verbose = options.verbose === true
  const staleHint = options.staleHint !== false
  const hintForRow = typeof options.hint === "function" ? options.hint : (row) => hintOf(row, staleHint)
  const prepared = rows.map((row) => {
    const status = row.status ?? "unknown"
    return {
      row,
      status,
      glyph: statusGlyph(status),
      sid: String(row.sessionID ?? ""),
      identity: identityOf(row),
      elapsed: Number.isFinite(row.elapsedMs) ? formatShortDuration(row.elapsedMs) : "",
    }
  })
  const sidWidth = Math.max(0, ...prepared.map((entry) => entry.sid.length))
  const identityWidth = Math.max(0, ...prepared.map((entry) => entry.identity.length))
  const statusWidth = Math.max(0, ...prepared.map((entry) => entry.status.length))
  const elapsedWidth = Math.max(0, ...prepared.map((entry) => entry.elapsed.length))

  const lines = []
  for (const entry of prepared) {
    const head = [entry.glyph, entry.sid.padEnd(sidWidth), entry.identity.padEnd(identityWidth), entry.status.padEnd(statusWidth), entry.elapsed.padEnd(elapsedWidth)]
      .filter((segment, index) => index !== 2 || segment.trim().length > 0)
      .join("  ")
      .trimEnd()
    const hint = hintForRow(entry.row)
    lines.push(hint ? `${head}  ${hint}` : head)

    const detail = []
    const activity = activityOf(entry.row)
    if (activity) detail.push(activity)
    const todo = todoOf(entry.row)
    if (todo) detail.push(todo)
    if (entry.row.todo?.current) detail.push(JSON.stringify(entry.row.todo.current))
    const calls = callsOf(entry.row)
    if (calls) detail.push(calls)
    const cost = costOf(entry.row)
    if (cost) detail.push(cost)
    if (Number.isFinite(entry.row.sinceLastActivityMs)) {
      detail.push(`last activity ${formatShortDuration(entry.row.sinceLastActivityMs)} ago`)
    }
    if (verbose) {
      if (entry.row.parentID) detail.push(`parent=${entry.row.parentID}`)
      if (Number.isFinite(entry.row.sinceLastProgressMs)) {
        detail.push(`sinceProgress=${formatShortDuration(entry.row.sinceLastProgressMs)}`)
      }
      if (Number.isFinite(entry.row.sinceLastEventMs)) {
        detail.push(`lastEvent=${formatShortDuration(entry.row.sinceLastEventMs)}`)
      }
      const breakdown = toolBreakdown(entry.row)
      if (breakdown) detail.push(breakdown)
    }
    if (detail.length > 0) lines.push(`    ${detail.join(" · ")}`)
  }
  return lines
}

/**
 * Render the aggregate header for a child list, e.g.
 * `3 children · 2 running · 1 stale · 1 done`.
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function renderChildHeader(rows) {
  const order = Object.entries(STATUS_ORDER)
    .sort((a, b) => a[1] - b[1])
    .map(([status]) => status)
  const counts = {}
  for (const row of rows) {
    const status = row.status ?? "unknown"
    counts[status] = (counts[status] ?? 0) + 1
  }
  const segments = order.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`)
  const noun = rows.length === 1 ? "child" : "children"
  return [`${rows.length} ${noun}`, ...segments].join(" · ")
}
