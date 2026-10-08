/**
 * Event-driven progress reporting for background subagents (OpenCode V1 plugin).
 *
 * A background subagent runs to completion with no visibility until it finishes:
 * the parent only learns the outcome from the final completion notice. This
 * module lets a child publish its progress to the parent as it works, using the
 * `todo.updated` event the child emits whenever it calls `todowrite`.
 *
 * It is deliberately event-driven, never polled. On each `todo.updated` from a
 * child session it injects a short report into the parent session via the async
 * prompt endpoint (the same mechanism OpenCode uses for its native completion
 * notice). The injection is fire-and-forget and does not block the child.
 *
 * The report is injected as a NON-synthetic text part so it is visible inline in
 * the parent's transcript (a synthetic part is hidden from the TUI). It renders
 * as an agent-colored inline entry headed by `⤷ <child> reporting to <parent>`,
 * mirroring a tool-call row without needing a core change. The parent model sees
 * the same text, so a visible report costs no extra model context.
 *
 * Every injection costs the parent a full model turn, so reports are coalesced:
 * at most one report per child per `intervalMs` (default 120000 ms), and exactly
 * one final report when every todo reaches a terminal state. A child that never
 * calls `todowrite` produces no reports.
 *
 * Loop safety: only sessions that have a parent (i.e. child sessions) are
 * considered, so the parent's own `todowrite` never re-triggers a report.
 *
 * Two delivery modes, selected by `OPENCODE_SUBAGENT_PROGRESS`:
 *
 *   - `1` / `true` / `on` / `yes` → **inject**: the report is written into the
 *     parent session as a text part (a full model turn; visible in the
 *     transcript).
 *   - `0` → **toast**: the report is shown as a transient TUI toast instead, so
 *     no model turn is spent and the parent transcript stays clean. The toast
 *     title carries the child's identity (`agent · slug · session title`) and
 *     the message carries the `in_progress` todo title.
 *
 * Any other value leaves progress reporting off.
 *
 * @module subagent-progress
 */

import { resolveTarget } from "./subagent-control.js"

/** Default minimum delay (ms) between two progress reports for the same child. */
export const DEFAULT_PROGRESS_MS = 120000

/**
 * System-prompt instruction appended to every child (subagent) session so the
 * child keeps its `todowrite` list current. Progress reports are driven by the
 * `todo.updated` event, so a child that never calls `todowrite` is invisible to
 * its parent. Written in English (technical artifacts) and kept terse: it is
 * appended to the system prompt on every request.
 */
export const PROGRESS_SYSTEM_INSTRUCTION = [
  "## Progress reporting (required)",
  "",
  "You are a background subagent running asynchronously. Your parent agent cannot",
  "see your work while you run, so your `todowrite` list is the only channel that",
  "reports progress to it. Keep it accurate and current:",
  "",
  "1. Create the todo list before you start, one item per concrete step.",
  "2. Mark exactly one item `in_progress` before you begin working on it.",
  "3. Mark it `completed` the moment it is done, then start the next item.",
  "",
  "Each `todowrite` update is streamed to the parent as a progress report. Update",
  "the list as you go; never batch every change into a single update at the end.",
].join("\n")

/** Values accepted as "enabled" for the opt-in env gate. */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"])

/** Values accepted as the explicit "toast" mode. */
const FALSY = new Set(["0", "false", "no", "off", "n"])

/**
 * Resolve the progress delivery mode from `OPENCODE_SUBAGENT_PROGRESS`:
 *
 *   - `"inject"` — truthy value: write the report into the parent session.
 *   - `"toast"`  — `0` / `false` / `no` / `off`: show a transient TUI toast.
 *   - `"off"`    — unset or unrecognized: progress reporting disabled.
 *
 * @returns {"inject" | "toast" | "off"}
 */
export function progressMode() {
  const value = String(process.env.OPENCODE_SUBAGENT_PROGRESS ?? "").trim().toLowerCase()
  if (TRUTHY.has(value)) return "inject"
  if (FALSY.has(value)) return "toast"
  return "off"
}

/**
 * Whether progress reporting is active in either mode (inject or toast).
 *
 * @returns {boolean}
 */
export function progressEnabled() {
  return progressMode() !== "off"
}

/**
 * Configured minimum interval (ms) between progress reports for one child.
 * Falls back to {@link DEFAULT_PROGRESS_MS} when unset or not a positive number.
 *
 * @returns {number}
 */
export function progressIntervalMs() {
  const raw = Number(String(process.env.OPENCODE_SUBAGENT_PROGRESS_MS ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PROGRESS_MS
}

/**
 * Whether a todo is in a terminal state (no further progress expected).
 *
 * @param {{ status?: string } | undefined} todo
 * @returns {boolean}
 */
export function isTerminalTodo(todo) {
  return todo?.status === "completed" || todo?.status === "cancelled"
}

/**
 * Summarize a todo list into counts and a compact textual breakdown.
 *
 * @param {Array<{ content?: string, status?: string, priority?: string }>} todos
 * @returns {{
 *   total: number,
 *   completed: number,
 *   cancelled: number,
 *   inProgress: number,
 *   pending: number,
 *   terminal: boolean,
 *   text: string,
 * }}
 */
export function summarizeTodos(todos) {
  const list = Array.isArray(todos) ? todos : []
  const count = (status) => list.filter((todo) => todo?.status === status).length
  const completed = count("completed")
  const cancelled = count("cancelled")
  const inProgress = count("in_progress")
  const pending = count("pending")
  const total = list.length
  const terminal = total > 0 && list.every((todo) => isTerminalTodo(todo))
  const text = `${completed}/${total} done · ${inProgress} in_progress · ${pending} pending`
  return { total, completed, cancelled, inProgress, pending, terminal, text }
}

/**
 * Render the report text injected into the parent session.
 *
 * The header reads like an inline tool-call row: an arrow icon, the reporting
 * child agent, the child's session slug (its "nickname"), and the recipient
 * parent agent, followed by the compact counts. Each todo is listed beneath it.
 *
 * @param {{ sessionID: string, agent?: string, nickname?: string, parentAgent?: string, parentID?: string, title?: string, todos?: Array<object> }} input
 * @returns {string}
 */
export function formatProgressReport(input) {
  const summary = summarizeTodos(input?.todos)
  const reporter = input?.agent || input?.sessionID || "subagent"
  const nickname = input?.nickname ? ` · ${input.nickname}` : ""
  const recipient = input?.parentAgent || input?.parentID || "parent"
  const title = input?.title ? ` · ${JSON.stringify(input.title)}` : ""
  const header = `⤷ ${reporter}${nickname} · reporting to ${recipient}${title} — ${summary.text}`
  const lines = (Array.isArray(input?.todos) ? input.todos : []).map(
    (todo) => `  - [${todo?.status ?? "?"}] ${todo?.content ?? ""}`.trimEnd(),
  )
  return [header, ...lines].join("\n")
}

/**
 * Render the TUI toast for a progress report (the `OPENCODE_SUBAGENT_PROGRESS=0`
 * mode). The title carries the child's identity — agent, session slug
 * ("nickname"), and the session title — and the message is the title of the
 * `in_progress` todo (falling back to the compact counts when none is active).
 *
 * @param {{ sessionID: string, agent?: string, nickname?: string, title?: string, todos?: Array<object> }} input
 * @returns {{ title: string, message: string, variant: "info" }}
 */
export function formatProgressToast(input) {
  const reporter = input?.agent || input?.sessionID || "subagent"
  const nickname = input?.nickname ? ` · ${input.nickname}` : ""
  const title = input?.title ? ` · ${input.title}` : ""
  const active = (Array.isArray(input?.todos) ? input.todos : []).find((todo) => todo?.status === "in_progress")
  const message = active?.content ? String(active.content) : summarizeTodos(input?.todos).text
  return { title: `⤷ ${reporter}${nickname}${title}`, message, variant: "info" }
}

/**
 * Decide whether a report should be sent for a child, given its per-child state.
 *
 * A final report (all todos terminal) is sent at most once. A non-final report is
 * sent only when the summary changed and the coalescing interval has elapsed.
 *
 * @param {{ lastReportAt: number, lastText: string, finalSent: boolean } | undefined} state
 * @param {{ terminal: boolean, text: string }} summary
 * @param {number} now
 * @param {number} intervalMs
 * @returns {boolean}
 */
export function shouldReport(state, summary, now, intervalMs) {
  if (summary.terminal) return !state?.finalSent
  if (state?.lastText === summary.text) return false
  if (state && now - state.lastReportAt < intervalMs) return false
  return true
}

/**
 * Create the progress reporter: an `event` hook that watches child `todowrite`
 * updates and injects coalesced progress reports into the parent session.
 *
 * @param {{
 *   client?: object,
 *   now?: () => number,
 *   intervalMs?: number,
 *   onError?: (error: unknown) => void,
 * }} [options]
 * @returns {{
 *   event: (input: { event: unknown }) => Promise<void>,
 *   systemTransform: (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>,
 *   dispose: () => Promise<void>,
 * }}
 */
export function createSubagentProgress(options = {}) {
  const client = options.client
  const now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? progressIntervalMs()
  const mode = options.mode ?? progressMode()
  const onError = options.onError
  const states = new Map()
  const parents = new Map()
  const roots = new Set()
  const agents = new Map()
  const slugs = new Map()
  const titles = new Map()

  /** Record child -> parent linkage (or mark a session as a root) from info. */
  function rememberParent(info) {
    if (!info || typeof info.id !== "string") return
    if (typeof info.agent === "string" && info.agent) agents.set(info.id, info.agent)
    if (typeof info.slug === "string" && info.slug) slugs.set(info.id, info.slug)
    if (typeof info.title === "string" && info.title) titles.set(info.id, info.title)
    if (typeof info.parentID === "string" && info.parentID) {
      parents.set(info.id, info.parentID)
      roots.delete(info.id)
    } else {
      roots.add(info.id)
    }
  }

  /** Resolve a session's parent id from the registry, then the SDK. */
  async function resolveParent(sessionID) {
    if (parents.has(sessionID)) return parents.get(sessionID)
    if (roots.has(sessionID)) return undefined
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const response = await api.get({ path: { id: sessionID } })
      const info = response && typeof response === "object" && "data" in response ? response.data : response
      rememberParent(info)
      return parents.get(sessionID)
    } catch {
      return undefined
    }
  }

  /**
   * Append the progress instruction to a child session's system prompt. Only
   * child sessions (those with a parent) get it, so the parent and root
   * sessions are unaffected. Best-effort: a session that cannot be resolved to a
   * child is left untouched.
   */
  async function systemTransform(input, output) {
    const sessionID = input?.sessionID
    if (typeof sessionID !== "string" || !sessionID) return
    if (!output || !Array.isArray(output.system)) return
    const parentID = await resolveParent(sessionID)
    if (!parentID) return
    output.system.push(PROGRESS_SYSTEM_INSTRUCTION)
  }

  /**
   * Best-effort injection of one report into the parent session. The report is
   * sent as a NON-synthetic text part so the parent's TUI renders it inline.
   */
  async function inject(parentID, text) {
    const api = client?.session
    if (typeof api?.promptAsync !== "function") return false
    let target = {}
    if (typeof api?.get === "function") {
      try {
        const response = await api.get({ path: { id: parentID } })
        const info = response && typeof response === "object" && "data" in response ? response.data : response
        target = resolveTarget(info)
      } catch {
        // Preserve-the-parent-identity is best-effort; default identity is fine.
      }
    }
    await api.promptAsync({
      path: { id: parentID },
      body: { parts: [{ type: "text", text }], ...target },
    })
    return true
  }

  /** Read a session's agent name and slug (best-effort) for the report header. */
  async function agentOf(sessionID) {
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const response = await api.get({ path: { id: sessionID } })
      const info = response && typeof response === "object" && "data" in response ? response.data : response
      rememberParent(info)
      return typeof info?.agent === "string" && info.agent ? info.agent : undefined
    } catch {
      return undefined
    }
  }

  /** Read a session's slug (its "nickname") from the registry, then the SDK. */
  async function slugOf(sessionID) {
    if (slugs.has(sessionID)) return slugs.get(sessionID)
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const response = await api.get({ path: { id: sessionID } })
      const info = response && typeof response === "object" && "data" in response ? response.data : response
      rememberParent(info)
      return slugs.get(sessionID)
    } catch {
      return undefined
    }
  }

  /** Read a session's title from the registry, then the SDK (best-effort). */
  async function titleOf(sessionID) {
    if (titles.has(sessionID)) return titles.get(sessionID)
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const response = await api.get({ path: { id: sessionID } })
      const info = response && typeof response === "object" && "data" in response ? response.data : response
      rememberParent(info)
      return titles.get(sessionID)
    } catch {
      return undefined
    }
  }

  /**
   * Best-effort TUI toast for one report. Non-blocking: a missing `tui` API is
   * silently ignored so the event handler never throws.
   */
  async function toast(input) {
    const api = client?.tui
    if (typeof api?.showToast !== "function") return false
    await api.showToast({ body: { title: input.title, message: input.message, variant: input.variant, duration: 5000 } })
    return true
  }

  /** Handle one plugin event. */
  async function event(input) {
    const evt = input?.event
    if (!evt || typeof evt !== "object") return
    const props = evt.properties ?? {}
    if (evt.type === "session.created" || evt.type === "session.updated") {
      rememberParent(props.info)
      return
    }
    if (evt.type !== "todo.updated") return

    const sessionID = props.sessionID
    const todos = props.todos
    if (typeof sessionID !== "string" || !sessionID) return

    const parentID = await resolveParent(sessionID)
    if (!parentID) return

    const summary = summarizeTodos(todos)
    if (summary.total === 0) return

    const state = states.get(sessionID)
    if (!shouldReport(state, summary, now(), intervalMs)) return

    const agent = agents.get(sessionID) ?? (await agentOf(sessionID))
    const nickname = await slugOf(sessionID)
    try {
      if (mode === "toast") {
        const title = await titleOf(sessionID)
        const payload = formatProgressToast({ sessionID, agent, nickname, title, todos })
        const sent = await toast(payload)
        if (!sent) return
      } else {
        const parentAgent = agents.get(parentID)
        const text = formatProgressReport({ sessionID, agent, nickname, parentAgent, parentID, title: props.title, todos })
        const sent = await inject(parentID, text)
        if (!sent) return
      }
    } catch (error) {
      onError?.(error)
      return
    }

    states.set(sessionID, {
      lastReportAt: now(),
      lastText: summary.text,
      finalSent: summary.terminal || Boolean(state?.finalSent),
    })
  }

  return {
    event,
    systemTransform,
    dispose: async () => {
      states.clear()
      parents.clear()
      roots.clear()
      agents.clear()
      slugs.clear()
      titles.clear()
    },
  }
}
