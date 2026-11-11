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
 * subsequent idle). A short dedupe window additionally suppresses a duplicate
 * notice for the same child, so a noisy idle sequence cannot wake the parent
 * twice. Only sessions registered through {@link
 * createSubagentCompletion}'s `onSend` are ever announced, so the initial
 * background dispatch is untouched (no double notice).
 *
 * Each notice is two information-dense lines: identity, outcome, duration, tool
 * calls, context usage, and the (de-quoted-suffix) title, then a ready-to-run
 * `subagent_result` call hint. Outcome/duration/calls/tokens come from the
 * status registry when the status feature is enabled; without it they are
 * omitted rather than faked, and the injected text part carries the same facts
 * as structured metadata so the model never parses the prose.
 *
 * Runtime overlap: `src/tui.tsx` (`subagentToasts`) also shows a toast, but on a
 * different surface — the TUI's own `api.ui.toast` (gated by
 * `OPENCODE_SUBAGENT_NOTIFY`), not the server's `client.tui.showToast`. The two
 * run in separate processes and cannot see each other's notices, so the `toast`
 * channel here never double-fires the TUI toast.
 *
 * @module subagent-completion
 */

import { formatShortDuration, formatTokens, usedTokens } from "./subagent-format.js"
import { completionChannel, resolveTarget, unwrap } from "./subagent-utils.js"

// Re-export the dependency-free env gate/channel resolver so this module's
// public surface is unchanged (tests import them from here).
export { completionChannel, completionEnabled } from "./subagent-utils.js"

/** Default lifetime (ms) of an armed completion notice. */
export const DEFAULT_PENDING_TTL_MS = 600000

/**
 * Default dedupe window (ms). A second notice for the same child inside this
 * window is suppressed, so a noisy idle sequence cannot wake the parent twice.
 */
export const DEFAULT_DEDUPE_MS = 5000

/** Outcome words the notice may print, in priority order. */
const OUTCOMES = new Set(["done", "error", "stale", "dead"])

/** Strips the redundant `(@<agent> subagent)` suffix some titles carry. */
const TITLE_SUFFIX_RE = /\s*\(@[^)]*\bsubagent\)\s*$/i

/**
 * Read a positive integer from an environment variable, falling back when unset
 * or invalid.
 *
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function envInt(key, fallback) {
  const raw = Number(String(process.env[key] ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/**
 * Read a child's classified registry item, tolerating a missing/partial
 * registry: an absent `get`, an untracked child, or a throwing getter all
 * degrade to `undefined` so the notice still renders from SDK data alone.
 *
 * @param {{ get?: (sessionID: string) => object | undefined } | undefined} registry
 * @param {string} [sessionID]
 * @returns {object | undefined}
 */
function registryItem(registry, sessionID) {
  if (!registry || typeof registry.get !== "function" || typeof sessionID !== "string" || !sessionID) return undefined
  try {
    const item = registry.get(sessionID)
    return item && typeof item === "object" ? item : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize a notice's inputs (SDK identity + optional registry stats) into the
 * single metadata object attached to the injected part.
 *
 * Registry values win over caller-supplied ones. Every field is omitted rather
 * than fabricated when unknown; `outcome` always resolves to a real word
 * (`done` when a child simply went idle) because "completed" must never stand in
 * for an error.
 *
 * @param {{ sessionID?: string, agent?: string, nickname?: string, slug?: string,
 *   title?: string, outcome?: "done" | "error" | "stale" | "dead", elapsedMs?: number,
 *   toolCalls?: number, tokens?: object, contextUsed?: number,
 *   registry?: { get?: (sessionID: string) => object | undefined } }} [input]
 * @returns {{ sessionID: string | undefined, slug: string | undefined,
 *   agent: string | undefined, outcome: "done" | "error" | "stale" | "dead",
 *   elapsedMs: number | undefined, toolCalls: number | undefined,
 *   tokens: object | undefined, contextUsed: number | undefined,
 *   title: string | undefined }}
 */
export function formatCompletionMetadata(input = {}) {
  const item = registryItem(input.registry, input.sessionID)
  const status = typeof item?.status === "string" ? item.status : undefined
  const requested = typeof input.outcome === "string" ? input.outcome.toLowerCase() : undefined
  const outcome = OUTCOMES.has(status) ? status : OUTCOMES.has(requested) ? requested : "done"

  const elapsedMs = Number.isFinite(item?.elapsedMs)
    ? item.elapsedMs
    : Number.isFinite(input.elapsedMs)
      ? input.elapsedMs
      : undefined
  const toolCalls = Number.isFinite(item?.toolCalls)
    ? item.toolCalls
    : Number.isFinite(input.toolCalls)
      ? input.toolCalls
      : undefined
  const tokens = item?.tokens ?? input.tokens
  const contextUsed = Number.isFinite(item?.contextUsed)
    ? item.contextUsed
    : Number.isFinite(input.contextUsed)
      ? input.contextUsed
      : usedTokens(tokens)
  const rawTitle =
    typeof input.title === "string" && input.title
      ? input.title
      : typeof item?.title === "string" && item.title
        ? item.title
        : undefined
  // Drop the redundant `(@<agent> subagent)` suffix; the agent is printed once
  // in the header already.
  const title = rawTitle ? rawTitle.replace(TITLE_SUFFIX_RE, "") : undefined

  return {
    sessionID: typeof input.sessionID === "string" && input.sessionID ? input.sessionID : undefined,
    slug: typeof input.nickname === "string" && input.nickname ? input.nickname : input.slug || item?.slug,
    agent: input.agent || item?.agent,
    outcome,
    elapsedMs,
    toolCalls,
    tokens,
    contextUsed,
    title,
  }
}

/**
 * `slug · agent` identity segment, each printed exactly once. Falls back to the
 * literal `subagent` when neither is known, so the header never dangles.
 *
 * @param {{ slug?: string, agent?: string }} meta
 * @returns {string}
 */
function identitySegment(meta) {
  const parts = []
  if (meta.slug) parts.push(meta.slug)
  if (meta.agent) parts.push(meta.agent)
  return parts.length > 0 ? parts.join(" · ") : "subagent"
}

/** `<outcome>` or `<outcome> in <duration>` when the elapsed time is known. A
 * sub-second elapsed time renders as the bare outcome: `done in 0s` is noise. */
function outcomeSegment(meta) {
  return Number.isFinite(meta.elapsedMs) && meta.elapsedMs >= 1000
    ? `${meta.outcome} in ${formatShortDuration(meta.elapsedMs)}`
    : meta.outcome
}

/** `<n> calls` / `1 call`; omitted when the count is unknown or zero. */
function callsSegment(toolCalls) {
  if (!Number.isFinite(toolCalls) || toolCalls <= 0) return undefined
  return `${toolCalls} ${toolCalls === 1 ? "call" : "calls"}`
}

/** `<12.3k> ctx`; omitted when usage is unknown (never a placeholder). */
function contextSegment(contextUsed) {
  if (!Number.isFinite(contextUsed) || contextUsed <= 0) return undefined
  return `${formatTokens(contextUsed)} ctx`
}

/**
 * Render the two-line completion notice injected into the parent session:
 *
 *   ⤷ witty-river · backend · done in 12m04s · 21 calls · 48.1k ctx · "Title"
 *     → subagent_result sessionID=ses_...
 *
 * Line two is a ready-to-run call hint so the model copies the id instead of
 * re-deriving it. Unknown segments are omitted, never padded with `?`/`n/a`.
 *
 * @param {Parameters<typeof formatCompletionMetadata>[0]} [input]
 * @returns {string}
 */
export function formatCompletionNotice(input) {
  const meta = formatCompletionMetadata(input)
  const segments = [identitySegment(meta), outcomeSegment(meta)]
  const calls = callsSegment(meta.toolCalls)
  if (calls) segments.push(calls)
  const context = contextSegment(meta.contextUsed)
  if (context) segments.push(context)
  if (meta.title) segments.push(JSON.stringify(meta.title))
  const header = `⤷ ${segments.join(" · ")}`
  if (!meta.sessionID) return header
  const suffix = meta.outcome === "error" ? " (terminal error)" : ""
  return `${header}\n  → subagent_result sessionID=${meta.sessionID}${suffix}`
}

/**
 * Render the completion notice as a TUI toast payload (the `toast` channel).
 *
 * The title carries identity plus outcome; the message carries the transient
 * cost detail. Same facts as the inline notice, split for a small surface.
 *
 * @param {Parameters<typeof formatCompletionMetadata>[0]} [input]
 * @returns {{ title: string, message: string, variant: "info" }}
 */
export function formatCompletionToast(input) {
  const meta = formatCompletionMetadata(input)
  const title = `⤷ ${identitySegment(meta)} · ${meta.outcome}`
  const details = []
  if (Number.isFinite(meta.elapsedMs)) details.push(formatShortDuration(meta.elapsedMs))
  const calls = callsSegment(meta.toolCalls)
  if (calls) details.push(calls)
  const context = contextSegment(meta.contextUsed)
  if (context) details.push(context)
  if (meta.title) details.push(JSON.stringify(meta.title))
  return { title, message: details.join(" · "), variant: "info" }
}

/**
 * Create the completion-notice feature: an `event` subscriber plus an `onSend`
 * registrar called from the `subagent_send` tool path.
 *
 * @param {{
 *   client?: object,
 *   registry?: { get?: (sessionID: string) => object | undefined },
 *   enabled?: boolean,
 *   channel?: "toast" | "chat" | "inline" | "both" | "off",
 *   onError?: (error: unknown) => void,
 *   now?: () => number,
 *   pendingTtlMs?: number,
 *   dedupeMs?: number,
 * }} [options]
 * @returns {{
 *   event: (input: { event: unknown }) => Promise<void>,
 *   onSend: (parentID: string, childID: string) => void,
 *   metadataOf: (childID: string, entry?: { armedAt?: number }) => Promise<object>,
 *   dispose: () => Promise<void>,
 * }}
 */
export function createSubagentCompletion(options = {}) {
  const client = options.client
  // Registry stats (outcome/duration/calls/tokens) come from the status feature.
  // Absent in a status-free build: every reader degrades to SDK-only data.
  const registry = options.registry
  const channel = options.channel ?? completionChannel()
  const enabled = options.enabled ?? channel !== "off"
  const onError = options.onError
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const pendingTtlMs = Number.isFinite(options.pendingTtlMs)
    ? Math.max(0, Math.floor(options.pendingTtlMs))
    : envInt("OPENCODE_SUBAGENT_PENDING_TTL_MS", DEFAULT_PENDING_TTL_MS)
  const dedupeMs = Number.isFinite(options.dedupeMs)
    ? Math.max(0, Math.floor(options.dedupeMs))
    : DEFAULT_DEDUPE_MS
  /**
   * One-shot childID -> `{ parentID, armedAt }` registrations created by
   * `onSend`. Each carries its arming time so an entry whose child never goes
   * idle can be pruned instead of leaking for the process lifetime.
   */
  const pending = new Map()
  /**
   * childID -> `{ identity, at }`, cached so repeated notices skip the
   * session.get. `at` is the last access, so an entry ages out on the same TTL
   * clock as `pending` instead of accumulating one entry per child forever.
   */
  const identities = new Map()
  /** childID -> last notice time, so a rapid duplicate idle is suppressed. */
  const deliveredAt = new Map()

  /**
   * Drop registrations older than the TTL. Without this, a follow-up queued
   * into a child that never emits idle would hold its entry forever. The
   * identity cache and the dedupe ledger age out on the same clock so neither
   * can grow per child forever.
   */
  function prunePending() {
    if (!(pendingTtlMs > 0)) return
    const current = now()
    for (const [id, entry] of pending) if (current - entry.armedAt > pendingTtlMs) pending.delete(id)
    for (const [id, entry] of identities) if (current - entry.at > pendingTtlMs) identities.delete(id)
    for (const [id, at] of deliveredAt) if (current - at > pendingTtlMs) deliveredAt.delete(id)
  }

  /**
   * Record that a follow-up was queued into `childID`, so the child's next idle
   * notifies `parentID`. Ignored when the feature is disabled or ids are empty.
   */
  function onSend(parentID, childID) {
    if (!enabled) return
    if (typeof parentID !== "string" || !parentID) return
    if (typeof childID !== "string" || !childID) return
    pending.set(childID, { parentID, armedAt: now() })
  }

  /**
   * Best-effort child identity (agent/slug/title) for the notice header. The
   * result is cached per child (mirroring the progress reporter), so a child
   * announced across several follow-ups costs at most one `session.get` inside
   * the TTL window.
   */
  async function identityOf(sessionID) {
    const cached = identities.get(sessionID)
    if (cached) {
      // Refresh the last-access stamp so a still-active child is not evicted.
      cached.at = now()
      return cached.identity
    }
    const api = client?.session
    if (typeof api?.get !== "function") return undefined
    try {
      const info = unwrap(await api.get({ path: { id: sessionID } }))
      if (!info || typeof info !== "object") {
        identities.set(sessionID, { identity: undefined, at: now() })
        return undefined
      }
      const identity = {
        agent: typeof info.agent === "string" && info.agent ? info.agent : undefined,
        nickname: typeof info.slug === "string" && info.slug ? info.slug : undefined,
        title: typeof info.title === "string" && info.title ? info.title : undefined,
      }
      identities.set(sessionID, { identity, at: now() })
      return identity
    } catch {
      return undefined
    }
  }

  /**
   * Build the structured metadata for one child. Registry stats (outcome,
   * elapsed, calls, tokens) win when the status feature is present. Without a
   * registry, the only honest timing is the follow-up's own arm time (when the
   * queued message was sent), so that is used instead; outcome defaults to
   * `done` because an idle child finished its follow-up.
   *
   * @param {string} childID
   * @param {{ armedAt?: number }} [entry] the pending registration for this child
   * @returns {Promise<object>}
   */
  function metadataOf(childID, entry) {
    return identityOf(childID).then((identity) => {
      const elapsedMs =
        registryItem(registry, childID) === undefined && Number.isFinite(entry?.armedAt)
          ? Math.max(0, now() - entry.armedAt)
          : undefined
      return formatCompletionMetadata({ sessionID: childID, elapsedMs, ...identity, registry })
    })
  }

  /**
   * Inline channel: inject the notice into the parent session as a visible text
   * part. The parent's own agent/model is preserved so the notice does not
   * rewrite its identity. The part carries the same facts as `metadata` so the
   * model never has to parse the prose.
   */
  async function notifyInline(parentID, metadata) {
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
    const text = formatCompletionNotice(metadata)
    await api.promptAsync({
      path: { id: parentID },
      // NON-synthetic (mirrors subagent-progress.js): a synthetic part is hidden
      // from the parent's TUI, so the notice would never reach the user.
      body: { parts: [{ type: "text", text, metadata }], ...target },
    })
    return true
  }

  /** Chat channel: a hidden, no-reply session part (no model turn). */
  async function notifyChat(parentID, metadata) {
    const api = client?.session
    if (typeof api?.prompt !== "function") return false
    const text = formatCompletionNotice(metadata)
    await api.prompt({
      path: { id: parentID },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true, metadata }] },
    })
    return true
  }

  /** Toast channel: a transient TUI toast (no model turn, not in transcript). */
  async function notifyToast(metadata) {
    const api = client?.tui
    if (typeof api?.showToast !== "function") return false
    const payload = formatCompletionToast(metadata)
    await api.showToast({ body: { ...payload, duration: 5000 } })
    return true
  }

  /**
   * Deliver the notice over the configured channel(s). Channels are independent
   * (DCP-style): `both` fires each, a single channel fires only itself. The
   * metadata is resolved once per notice and shared by every channel.
   *
   * @param {string} parentID
   * @param {string} childID
   * @param {{ armedAt?: number }} [entry]
   */
  async function dispatch(parentID, childID, entry) {
    let sent = false
    const metadata = await metadataOf(childID, entry)
    if (channel === "toast" || channel === "both") sent = (await notifyToast(metadata)) || sent
    if (channel === "inline" || channel === "both") sent = (await notifyInline(parentID, metadata)) || sent
    if (channel === "chat" || channel === "both") sent = (await notifyChat(parentID, metadata)) || sent
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
    // Prune on every event so an armed notice whose child never goes idle
    // cannot accumulate forever in a long-lived process.
    prunePending()
    const evt = input?.event
    if (!evt || typeof evt !== "object") return
    const resolveChild = handlers.get(evt.type)
    if (!resolveChild) return
    const childID = resolveChild(evt.properties ?? {})
    if (typeof childID !== "string" || !childID) return
    const entry = pending.get(childID)
    if (!entry) return
    const parentID = entry.parentID
    // One-shot: clear before dispatching so a throw cannot re-fire on a later idle.
    pending.delete(childID)
    // Dedupe: a second notice for the same child inside the window is noise (and
    // a full model turn on the inline channel). Suppress it; the parent already
    // holds the id from the first notice.
    const current = now()
    const last = deliveredAt.get(childID)
    if (dedupeMs > 0 && Number.isFinite(last) && current - last < dedupeMs) return
    deliveredAt.set(childID, current)
    try {
      await dispatch(parentID, childID, entry)
    } catch (error) {
      onError?.(error)
    }
  }

  return {
    event,
    onSend,
    metadataOf,
    dispose: async () => {
      pending.clear()
      identities.clear()
      deliveredAt.clear()
    },
  }
}
