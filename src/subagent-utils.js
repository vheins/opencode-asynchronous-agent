/**
 * Dependency-free helpers shared by the opt-in subagent feature modules.
 *
 * This module deliberately imports nothing. It exists so the core background
 * hook (`src/index.js`) and the progress/completion modules can share pure
 * helpers and env gates WITHOUT pulling in `@opencode-ai/plugin`: the plugin
 * package is needed only by the tool-registering modules (`subagent-status`,
 * `subagent-control`), which the core hook loads lazily.
 *
 * Two groups live here:
 *
 *   - Pure SDK helpers — `unwrap`, `resolveTarget` — previously defined in
 *     `subagent-control.js`. Progress/completion imported them from there, which
 *     transitively pulled the plugin package into every entry load; importing
 *     them from here instead breaks that edge.
 *   - Env gates — `statusEnabled`, `controlEnabled`, `progressEnabled`,
 *     `completionEnabled` (plus the channel resolvers they build on). The core
 *     hook needs these to decide whether to lazy-load a feature, so they cannot
 *     live inside the modules that must stay unloaded when disabled.
 *
 * @module subagent-utils
 */

/** Values accepted as "enabled" for the opt-in env gates. */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"])

/** Values accepted as the explicit "toast"/disabled mode. */
const FALSY = new Set(["0", "false", "no", "off", "n"])

/** Channel used when neither progress env switch selects one. */
export const DEFAULT_PROGRESS_CHANNEL = "chat"

/** Channels accepted by `OPENCODE_SUBAGENT_NOTIFICATION_TYPE`. */
const PROGRESS_CHANNELS = new Set(["toast", "chat", "inline", "both", "off"])

/** Channels accepted by `OPENCODE_SUBAGENT_COMPLETION_NOTIFY`. */
const COMPLETION_CHANNELS = new Set(["toast", "chat", "inline", "both", "off"])

/** Default completion channel: waking, so the notice is never silenced. */
const DEFAULT_COMPLETION_CHANNEL = "inline"

/**
 * Normalize an SDK response into its `data` payload, tolerating clients that
 * return the payload directly (tests) or wrapped as `{ data }` (SDK).
 *
 * @param {unknown} response
 * @returns {unknown}
 */
export function unwrap(response) {
  if (response && typeof response === "object" && "data" in response) return response.data
  return response
}

/**
 * Resolve the agent and model to preserve when prompting an existing child
 * session. OpenCode's `prompt` endpoint falls back to the *default* agent and
 * its model when `agent`/`model` are omitted, which silently rewrites a child's
 * identity (e.g. a `Frontend` child becomes the default `orchestrator` running
 * on the default model). Reading them back from the child session and passing
 * them through keeps the child on its own agent/model.
 *
 * Accepts either the session model shape (`{ id, providerID, variant }`) or the
 * prompt body shape (`{ modelID, providerID }`). The model `variant` is a
 * sibling identity field (e.g. reasoning effort) and is carried through as the
 * prompt body's top-level `variant` when present and not `"default"`. Returns
 * `{}` when nothing is known so callers can fall back to the default behavior.
 *
 * @param {{ agent?: string, model?: { id?: string, modelID?: string, providerID?: string, variant?: string } } | undefined} session
 * @returns {{ agent?: string, model?: { providerID: string, modelID: string }, variant?: string }}
 */
export function resolveTarget(session) {
  const result = {}
  if (!session || typeof session !== "object") return result
  if (typeof session.agent === "string" && session.agent) result.agent = session.agent
  const model = session.model
  const modelID = model && (typeof model.modelID === "string" ? model.modelID : model.id)
  if (model && typeof model.providerID === "string" && model.providerID && typeof modelID === "string" && modelID) {
    result.model = { providerID: model.providerID, modelID }
    if (typeof model.variant === "string" && model.variant && model.variant !== "default") result.variant = model.variant
  }
  return result
}

/**
 * Whether the opt-in status tool is enabled via `OPENCODE_SUBAGENT_STATUS`.
 *
 * @returns {boolean}
 */
export function statusEnabled() {
  return TRUTHY.has(String(process.env.OPENCODE_SUBAGENT_STATUS ?? "").trim().toLowerCase())
}

/**
 * Whether the control tool suite is enabled. True when
 * `OPENCODE_SUBAGENT_CONTROL` is truthy, or when the status tool gate
 * (`OPENCODE_SUBAGENT_STATUS`) is enabled.
 *
 * @returns {boolean}
 */
export function controlEnabled() {
  if (TRUTHY.has(String(process.env.OPENCODE_SUBAGENT_STATUS ?? "").trim().toLowerCase())) return true
  return TRUTHY.has(String(process.env.OPENCODE_SUBAGENT_CONTROL ?? "").trim().toLowerCase())
}

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
 * Resolve the delivery channel, orthogonal to whether reporting is enabled.
 *
 * `OPENCODE_SUBAGENT_NOTIFICATION_TYPE` selects the channel directly
 * (`toast` | `chat` | `inline` | `both` | `off`). When it is unset or
 * unrecognized, the legacy `OPENCODE_SUBAGENT_PROGRESS` switch is mapped so
 * existing configurations keep working: truthy → `inline`, `0` → `toast`,
 * unrecognized → `off`. When BOTH switches are unset, the default channel is
 * {@link DEFAULT_PROGRESS_CHANNEL} (`chat`).
 *
 * @returns {"toast" | "chat" | "inline" | "both" | "off"}
 */
export function progressChannel() {
  const explicit = String(process.env.OPENCODE_SUBAGENT_NOTIFICATION_TYPE ?? "").trim().toLowerCase()
  if (PROGRESS_CHANNELS.has(explicit)) return explicit
  const legacy = String(process.env.OPENCODE_SUBAGENT_PROGRESS ?? "").trim().toLowerCase()
  if (legacy) {
    const mapped = progressMode()
    if (mapped === "inject") return "inline"
    if (mapped === "toast") return "toast"
    return "off"
  }
  return DEFAULT_PROGRESS_CHANNEL
}

/**
 * Whether progress reporting is active in any channel. True when the resolved
 * channel is anything other than `off`, so the new
 * `OPENCODE_SUBAGENT_NOTIFICATION_TYPE` switch enables reporting on its own.
 *
 * @returns {boolean}
 */
export function progressEnabled() {
  return progressChannel() !== "off"
}

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
