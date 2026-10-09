/**
 * Emulated completion notice for `subagent_send` follow-ups (OpenCode V1 plugin).
 *
 * OpenCode pushes a completion notice to the parent only for the *initial*
 * `background: true` dispatch: the notice is tied to the subagent tool-part
 * lifecycle. A follow-up queued into an already-running child via
 * `subagent_send` is a direct `session.promptAsync` call with no parent tool
 * part, so no notice fires and the parent must poll `subagent_result`.
 *
 * This module emulates that missing notice without a core change. When
 * `subagent_send` queues a prompt it records `childID -> parentID`; on the
 * child's next `session.idle` (or `session.status{type:"idle"}`) it injects a
 * synthetic completion text into the parent via `session.promptAsync` — the same
 * channel OpenCode uses for its native notice.
 *
 * The registration is one-shot: it is cleared the moment the notice fires, so a
 * reused child session is announced exactly once per follow-up (not on every
 * subsequent idle). Only sessions registered through {@link
 * createSubagentCompletion}'s `onSend` are ever announced, so the initial
 * background dispatch is untouched (no double notice).
 *
 * Gated by the existing progress feature switch (`OPENCODE_SUBAGENT_PROGRESS`
 * via `progressEnabled()`): when that resolves to `off`, no notice is injected.
 *
 * @module subagent-completion
 */

import { resolveTarget, unwrap } from "./subagent-control.js"
import { progressEnabled } from "./subagent-progress.js"

/**
 * Render the synthetic completion notice injected into the parent session.
 *
 * Mirrors the progress-report header style so the parent sees a consistent
 * child identity, and states the follow-up completed plus how to read the
 * answer.
 *
 * @param {{ sessionID?: string, agent?: string, nickname?: string, title?: string }} input
 * @returns {string}
 */
export function formatCompletionNotice(input) {
  const reporter = input?.agent || input?.sessionID || "subagent"
  const nickname = input?.nickname ? ` · ${input.nickname}` : ""
  const title = input?.title ? ` · ${JSON.stringify(input.title)}` : ""
  const session = input?.sessionID ? ` (${input.sessionID})` : ""
  return (
    `⤷ ${reporter}${nickname}${title} · follow-up completed${session} — ` +
    `the subagent finished processing your queued message. ` +
    `Read its answer with subagent_result.`
  )
}

/**
 * Create the completion-notice feature: an `event` subscriber plus an `onSend`
 * registrar called from the `subagent_send` tool path.
 *
 * @param {{
 *   client?: object,
 *   enabled?: boolean,
 *   onError?: (error: unknown) => void,
 * }} [options]
 * @returns {{
 *   event: (input: { event: unknown }) => Promise<void>,
 *   onSend: (parentID: string, childID: string) => void,
 *   dispose: () => Promise<void>,
 * }}
 */
export function createSubagentCompletion(options = {}) {
  const client = options.client
  const enabled = options.enabled ?? progressEnabled()
  const onError = options.onError
  /** One-shot childID -> parentID registrations armed by `onSend`. */
  const pending = new Map()

  /**
   * Record that a follow-up was queued into `childID`, so the child's next idle
   * notifies `parentID`. Ignored when the feature is disabled or ids are empty.
   */
  function onSend(parentID, childID) {
    if (!enabled) return
    if (typeof parentID !== "string" || !parentID) return
    if (typeof childID !== "string" || !childID) return
    pending.set(childID, parentID)
  }

  /** Best-effort child identity (agent/slug/title) for the notice header. */
  async function identityOf(sessionID) {
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const info = unwrap(await api.get({ path: { id: sessionID } }))
      if (!info || typeof info !== "object") return undefined
      return {
        agent: typeof info.agent === "string" && info.agent ? info.agent : undefined,
        nickname: typeof info.slug === "string" && info.slug ? info.slug : undefined,
        title: typeof info.title === "string" && info.title ? info.title : undefined,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Inject the synthetic completion notice into the parent session. The parent's
   * own agent/model is preserved so the notice does not rewrite its identity.
   */
  async function notify(parentID, childID) {
    const api = client?.session
    if (typeof api?.promptAsync !== "function") return false
    let target = {}
    if (typeof api?.get === "function") {
      try {
        target = resolveTarget(unwrap(await api.get({ path: { id: parentID } })))
      } catch {
        // Preserving the parent identity is best-effort; the default is fine.
      }
    }
    const child = await identityOf(childID)
    const text = formatCompletionNotice({ sessionID: childID, ...child })
    await api.promptAsync({
      path: { id: parentID },
      body: { parts: [{ type: "text", text, synthetic: true }], ...target },
    })
    return true
  }

  /** Map-based dispatch: resolve the child session id from an idle event. */
  const handlers = new Map([
    ["session.idle", (props) => props.sessionID],
    ["session.status", (props) => (props.status?.type === "idle" ? props.sessionID : undefined)],
  ])

  /** Handle one plugin event. */
  async function event(input) {
    if (!enabled) return
    const evt = input?.event
    if (!evt || typeof evt !== "object") return
    const resolveChild = handlers.get(evt.type)
    if (!resolveChild) return
    const childID = resolveChild(evt.properties ?? {})
    if (typeof childID !== "string" || !childID) return
    const parentID = pending.get(childID)
    if (!parentID) return
    // One-shot: clear before injecting so a throw cannot re-fire on a later idle.
    pending.delete(childID)
    try {
      await notify(parentID, childID)
    } catch (error) {
      onError?.(error)
    }
  }

  return {
    event,
    onSend,
    dispose: async () => {
      pending.clear()
    },
  }
}
