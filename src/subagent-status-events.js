/**
 * Event dispatch for the subagent status registry.
 *
 * Each plugin event type maps to one handler that folds it into a tracked
 * record. The handlers are extracted from `./subagent-status.js` so the registry
 * stays small; every record-mutating primitive (clock advance, terminal
 * transition, tool tracking, upsert) is injected, so this module owns only the
 * event-to-signal mapping.
 *
 * Strength matters here. Strong signals (`message.updated`, `todo.updated`,
 * `session.status busy`) advance the progress clock; weak signals
 * (`session.updated`, an unknown status type) advance only the bookkeeping
 * clock. Collapsing the two is what produced zombie `running` records.
 *
 * @module subagent-status-events
 */

import { isSubagentSession, normalizeTokens } from "./subagent-liveness.js"
import { summarizeTodos } from "./subagent-summarize.js"

/**
 * Build the event handler map.
 *
 * @param {{
 *   get: (id: string) => object | undefined,
 *   upsert: (info: object, current: number, options?: { progressAt?: number }) => void,
 *   refreshIdentity: (record: object, info: object) => void,
 *   touchProgress: (record: object, current: number) => void,
 *   touchEvent: (record: object, current: number) => void,
 *   markTerminal: (record: object, status: "done" | "error", current: number) => void,
 *   applyToolPart: (record: object, part: object, current: number) => void,
 *   sessionProgressAt: (info: object, current: number) => number,
 *   remove: (id: string) => void,
 * }} deps
 * @returns {Map<string, (props: object, current: number) => void>}
 */
export function createEventHandlers(deps) {
  const {
    get,
    upsert,
    refreshIdentity,
    touchProgress,
    touchEvent,
    markTerminal,
    applyToolPart,
    sessionProgressAt,
    remove,
  } = deps

  return new Map([
    // A child appearing is live, but the insert is still driven by session INFO:
    // stamp from the session's own timestamps so a replay of an old session (a
    // plugin loaded mid-run) cannot manufacture a fresh progress clock.
    ["session.created", (props, current) => {
      if (isSubagentSession(props.info)) {
        upsert(props.info, current, { progressAt: sessionProgressAt(props.info, current) })
      }
    }],
    // Weak: a session row was rewritten, which proves nothing about work. An
    // UNTRACKED session inserted here is stamped from its own timestamps: using
    // `now()` would make an hours-old session look freshly alive.
    ["session.updated", (props, current) => {
      if (!isSubagentSession(props.info)) return
      const record = get(props.info.id)
      if (record) {
        refreshIdentity(record, props.info)
        touchEvent(record, current)
        return
      }
      upsert(props.info, current, { progressAt: sessionProgressAt(props.info, current) })
    }],
    ["session.status", (props, current) => {
      const record = get(props.sessionID)
      if (!record) return
      const type = props.status?.type
      record.lastStatusType = type
      if (type === "idle") {
        markTerminal(record, "done", current)
        return
      }
      if (type === "busy" || type === "retry") {
        touchProgress(record, current)
        return
      }
      // Unknown status type: bookkeeping only. Refreshing liveness here is what
      // produced zombie `running` records.
      touchEvent(record, current)
    }],
    ["session.idle", (props, current) => {
      const record = get(props.sessionID)
      if (record) markTerminal(record, "done", current)
    }],
    ["session.error", (props, current) => {
      const record = get(props.sessionID)
      if (record) markTerminal(record, "error", current)
    }],
    ["session.deleted", (props) => {
      const id = props.info?.id
      if (id) remove(id)
    }],
    ["message.updated", (props, current) => {
      const record = get(props.info?.sessionID)
      if (!record) return
      touchProgress(record, current)
      if (props.info?.role === "assistant") {
        if (typeof props.info.agent === "string" && props.info.agent) record.agent = props.info.agent
        // Latest message wins (never summed): summing across messages would
        // multiply usage by the turn count.
        const tokens = normalizeTokens(props.info.tokens)
        if (tokens) record.stats.tokens = tokens
        const providerID = props.info.providerID ?? props.info.model?.providerID
        const modelID = props.info.modelID ?? props.info.model?.id ?? props.info.model?.modelID
        if (typeof providerID === "string" && typeof modelID === "string" && providerID && modelID) {
          record.stats.model = { providerID, modelID }
        }
        const limit = props.info.model?.limit?.context ?? props.info.limit?.context
        if (Number.isFinite(limit) && limit > 0) record.stats.contextLimit = limit
        record.lastActivity = "streaming"
        record.lastActivityAt = current
      }
    }],
    ["message.part.updated", (props, current) => {
      const part = props.part
      const record = get(part?.sessionID)
      if (!record) return
      if (part?.type === "tool") {
        applyToolPart(record, part, current)
        return
      }
      record.lastActivity = "streaming"
      record.lastActivityAt = current
      touchProgress(record, current)
    }],
    // The strongest progress signal a subagent emits: each `todowrite`. Cache the
    // todo state so reports can show `n/m` progress with no extra SDK call.
    ["todo.updated", (props, current) => {
      const record = get(props.sessionID)
      if (!record) return
      record.todos = summarizeTodos(props.todos)
      record.lastActivity = "todo"
      record.lastActivityAt = current
      touchProgress(record, current)
    }],
  ])
}
