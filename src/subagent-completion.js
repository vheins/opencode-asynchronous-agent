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
 * child's next `session.idle` (or `session.status{type:"idle"}`) it delivers a
 * completion notice to the parent over the configured channel — the same
 * channels `subagent-progress.js` uses.
 *
 * Delivery is channel-based (DCP-style, orthogonal to whether it is enabled).
 * The channel comes from `OPENCODE_SUBAGENT_COMPLETION_NOTIFY` and defaults to
 * `inline` — a waking channel — so a follow-up completion ALWAYS reaches the
 * parent regardless of how progress reports are configured. This is deliberate:
 * completion and progress are decoupled, because silencing the completion notice
 * would leave the parent unaware that its queued message finished. The override
 * still wins:
 *
 *   - `inline` — a visible, non-synthetic text part via `session.promptAsync`
 *     (a full model turn; shown in the parent transcript).
 *   - `toast`  — a transient TUI toast via `client.tui.showToast`.
 *   - `chat`   — a hidden, no-reply part (`noReply` + `ignored`): no model turn.
 *   - `both`   — every channel above fires.
 *   - `off`    — no notice is delivered.
 *
 * The registration is one-shot: it is cleared the moment the notice fires, so a
 * reused child session is announced exactly once per follow-up (not on every
 * subsequent idle). Only sessions registered through {@link
 * createSubagentCompletion}'s `onSend` are ever announced, so the initial
 * background dispatch is untouched (no double notice).
 *
 * Runtime overlap: `src/tui.tsx` (`subagentToasts`) also shows a toast, but on a
 * different surface — the TUI's own `api.ui.toast` (gated by
 * `OPENCODE_SUBAGENT_NOTIFY`), not the server's `client.tui.showToast`. The two
 * run in separate processes and cannot see each other's notices, so the `toast`
 * channel here never double-fires the TUI toast.
 *
 * @module subagent-completion
 */

import { resolveTarget, unwrap } from "./subagent-control.js"

/** Channels accepted by `OPENCODE_SUBAGENT_COMPLETION_NOTIFY`. */
const COMPLETION_CHANNELS = new Set(["toast", "chat", "inline", "both", "off"])

/** Default completion channel: waking, so the notice is never silenced. */
const DEFAULT_COMPLETION_CHANNEL = "inline"

/**
 * Resolve the completion-notice channel. `OPENCODE_SUBAGENT_COMPLETION_NOTIFY`
 * selects it directly; when unset or unrecognized it defaults to `inline`
 * (waking) so the subagent -> main-agent completion notification is never
 * silenced by the progress channel.
 *
 * @returns {"toast" | "chat" | "inline" | "both" | "off"}
 */
export function completionChannel() {
  const explicit = String(process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY ?? "").trim().toLowerCase()
  if (COMPLETION_CHANNELS.has(explicit)) return explicit
  return DEFAULT_COMPLETION_CHANNEL
}

/**
 * Whether the completion notice is active in any channel. True when the
 * resolved channel is anything other than `off`, so
 * `OPENCODE_SUBAGENT_COMPLETION_NOTIFY` enables the feature on its own —
 * independent of the progress gate.
 *
 * @returns {boolean}
 */
export function completionEnabled() {
  return completionChannel() !== "off"
}

/**
 * Render the completion notice injected into the parent session.
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
 * Render the completion notice as a TUI toast payload (the `toast` channel).
 *
 * @param {{ sessionID?: string, agent?: string, nickname?: string, title?: string }} input
 * @returns {{ title: string, message: string, variant: "info" }}
 */
export function formatCompletionToast(input) {
  const reporter = input?.agent || input?.sessionID || "subagent"
  const nickname = input?.nickname ? ` · ${input.nickname}` : ""
  const title = input?.title ? ` · ${input.title}` : ""
  return { title: `⤷ ${reporter}${nickname}${title}`, message: "follow-up completed", variant: "info" }
}

/**
 * Create the completion-notice feature: an `event` subscriber plus an `onSend`
 * registrar called from the `subagent_send` tool path.
 *
 * @param {{
 *   client?: object,
 *   enabled?: boolean,
 *   channel?: "toast" | "chat" | "inline" | "both" | "off",
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
  const channel = options.channel ?? completionChannel()
  const enabled = options.enabled ?? channel !== "off"
  const onError = options.onError
  /** One-shot childID -> parentID registrations armed by `onSend`. */
  const pending = new Map()
  /** childID -> cached identity, so repeated notices skip the session.get. */
  const identities = new Map()

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

  /**
   * Best-effort child identity (agent/slug/title) for the notice header. The
   * result is cached per child (mirroring the progress reporter), so a child
   * announced across several follow-ups costs at most one `session.get`.
   */
  async function identityOf(sessionID) {
    if (identities.has(sessionID)) return identities.get(sessionID)
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const info = unwrap(await api.get({ path: { id: sessionID } }))
      if (!info || typeof info !== "object") {
        identities.set(sessionID, undefined)
        return undefined
      }
      const identity = {
        agent: typeof info.agent === "string" && info.agent ? info.agent : undefined,
        nickname: typeof info.slug === "string" && info.slug ? info.slug : undefined,
        title: typeof info.title === "string" && info.title ? info.title : undefined,
      }
      identities.set(sessionID, identity)
      return identity
    } catch {
      return undefined
    }
  }

  /**
   * Inline channel: inject the notice into the parent session as a visible text
   * part. The parent's own agent/model is preserved so the notice does not
   * rewrite its identity.
   */
  async function notifyInline(parentID, childID) {
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
      // NON-synthetic (mirrors subagent-progress.js): a synthetic part is hidden
      // from the parent's TUI, so the notice would never reach the user.
      body: { parts: [{ type: "text", text }], ...target },
    })
    return true
  }

  /** Chat channel: a hidden, no-reply session part (no model turn). */
  async function notifyChat(parentID, childID) {
    const api = client?.session
    if (typeof api?.prompt !== "function") return false
    const child = await identityOf(childID)
    const text = formatCompletionNotice({ sessionID: childID, ...child })
    await api.prompt({
      path: { id: parentID },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
    })
    return true
  }

  /** Toast channel: a transient TUI toast (no model turn, not in transcript). */
  async function notifyToast(childID) {
    const api = client?.tui
    if (typeof api?.showToast !== "function") return false
    const child = await identityOf(childID)
    const payload = formatCompletionToast({ sessionID: childID, ...child })
    await api.showToast({ body: { ...payload, duration: 5000 } })
    return true
  }

  /**
   * Deliver the notice over the configured channel(s). Channels are independent
   * (DCP-style): `both` fires each, a single channel fires only itself.
   */
  async function dispatch(parentID, childID) {
    let sent = false
    if (channel === "toast" || channel === "both") sent = (await notifyToast(childID)) || sent
    if (channel === "inline" || channel === "both") sent = (await notifyInline(parentID, childID)) || sent
    if (channel === "chat" || channel === "both") sent = (await notifyChat(parentID, childID)) || sent
    return sent
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
    // One-shot: clear before dispatching so a throw cannot re-fire on a later idle.
    pending.delete(childID)
    try {
      await dispatch(parentID, childID)
    } catch (error) {
      onError?.(error)
    }
  }

  return {
    event,
    onSend,
    dispose: async () => {
      pending.clear()
      identities.clear()
    },
  }
}
