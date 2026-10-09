/**
 * Background-subagent control tools for the OpenCode V1 plugin entrypoint.
 *
 * OpenCode's model is push-only: the parent is notified when a background child
 * finishes, but it cannot list children, fetch a child's result on demand, cancel
 * one, or send it extra context. These tools close that gap on top of the public
 * SDK (`PluginInput.client`):
 *
 *   - `subagent_children` — list a parent's child sessions
 *   - `subagent_result`   — fetch a child's final assistant answer
 *   - `subagent_cancel`   — abort a running child
 *   - `subagent_send`     — queue extra context into a running child
 *
 * There is deliberately no `subagent_wait`: blocking on a child defeats the
 * asynchronous model. OpenCode already pushes a completion notice to the parent
 * when a child finishes, and `subagent_children` / `subagent_result` cover
 * on-demand status. A wait tool is just polling in disguise.
 *
 * Every tool is non-destructive, degrades gracefully when an SDK method is
 * unavailable, and is disposed on unload. The pure helpers (`unwrap`,
 * `clampText`, `extractResult`, `pickStatus`, `resolveTarget`) are exported so
 * they can be unit-tested without an OpenCode runtime.
 *
 * Opt-in via `OPENCODE_SUBAGENT_CONTROL=1`; setting `OPENCODE_SUBAGENT_STATUS=1`
 * enables both the status tool and this suite.
 *
 * @module subagent-control
 */

import { tool } from "@opencode-ai/plugin"

/** Default maximum characters returned by `subagent_result`. */
export const DEFAULT_RESULT_CHARS = 20000

/** Values accepted as "enabled" for the opt-in env gate. */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"])

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
function isAnswerPart(part) {
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
 * Pick the status for a session from a status map, defaulting to idle.
 *
 * @param {Record<string, { type?: string }>} statusMap
 * @param {string} sessionID
 * @returns {{ type: string }}
 */
export function pickStatus(statusMap, sessionID) {
  const status = statusMap && typeof statusMap === "object" ? statusMap[sessionID] : undefined
  return status ?? { type: "idle" }
}

/**
 * Build the SDK client accessor used by every tool. Returns `undefined` when the
 * client lacks the needed session namespace, so callers can fail gracefully.
 *
 * @param {object} client
 * @returns {object | undefined}
 */
function sessionApi(client) {
  return client && typeof client === "object" ? client.session : undefined
}

/** Render an error thrown by an SDK call into a short string. */
function errorText(error) {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error?.message ?? error)
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
 * Create the control tool suite.
 *
 * @param {{
 *   client?: object,
 *   resultChars?: number,
 *   onSend?: (parentID: string, childID: string) => void,
 * }} [options]
 * @returns {{ tool: Record<string, unknown>, dispose: () => Promise<void> }}
 */
export function createSubagentControl(options = {}) {
  const client = options.client
  const resultChars = options.resultChars ?? envInt("OPENCODE_SUBAGENT_RESULT_CHARS", DEFAULT_RESULT_CHARS)
  const onSend = typeof options.onSend === "function" ? options.onSend : undefined

  const childrenTool = tool({
    description:
      "List the child (subagent) sessions spawned by a parent session. Use this to " +
      "discover background subagent session ids before waiting on, reading, or " +
      "cancelling them. Returns each child's id, title, agent linkage, and " +
      "current status.",
    args: {
      sessionID: tool.schema.string().describe("Parent session id whose children to list."),
    },
    async execute(args) {
      const api = sessionApi(client)
      if (typeof api?.children !== "function") {
        return { title: "subagent_children unavailable", output: "subagent_children unavailable: this OpenCode build exposes no session.children SDK method." }
      }
      try {
        const sessions = unwrap(await api.children({ path: { id: args.sessionID } }))
        const list = Array.isArray(sessions) ? sessions : []
        const statusMap = await readStatusMap(api)
        const rows = list.map((info) => ({
          sessionID: info.id,
          title: info.title,
          parentID: info.parentID,
          directory: info.directory,
          status: pickStatus(statusMap, info.id).type,
          updated: info.time?.updated,
        }))
        const header = `${rows.length} child session(s) of ${args.sessionID}`
        const body = rows.map(
          (row) => `- [${row.status}] ${row.sessionID} · title=${JSON.stringify(row.title ?? "")}`,
        )
        return {
          title: `subagent_children · ${rows.length}`,
          output: rows.length ? [header, ...body].join("\n") : `${header}.`,
          metadata: { children: rows },
        }
      } catch (error) {
        return { title: "subagent_children failed", output: `Failed to list children: ${errorText(error)}` }
      }
    },
  })

  const resultTool = tool({
    description:
      "Fetch the final assistant answer of a subagent session. Use after a child " +
      "finishes (or to inspect partial progress) instead of relying only on the " +
      "completion notice. Returns the last assistant text, any terminal error, " +
      "and the finish reason, truncated to a configurable length.",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to read."),
      maxChars: tool.schema
        .number()
        .optional()
        .describe("Maximum characters of the answer to return (default 20000)."),
    },
    async execute(args) {
      const api = sessionApi(client)
      if (typeof api?.messages !== "function") {
        return { title: "subagent_result unavailable", output: "subagent_result unavailable: this OpenCode build exposes no session.messages SDK method." }
      }
      try {
        const messages = unwrap(await api.messages({ path: { id: args.sessionID } }))
        const result = extractResult(messages)
        const limit = Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.floor(args.maxChars) : resultChars
        if (!result.found && !result.error) {
          return {
            title: "subagent_result · empty",
            output: `No assistant answer found for ${args.sessionID} (the subagent may still be running).`,
            metadata: { sessionID: args.sessionID, found: false },
          }
        }
        const parts = [clampText(result.text, limit)]
        if (result.error) parts.push(`[error] ${errorText(result.error)}`)
        if (result.finish) parts.push(`[finish] ${result.finish}`)
        return {
          title: `subagent_result · ${result.found ? "ok" : "error"}`,
          output: parts.join("\n"),
          metadata: {
            sessionID: args.sessionID,
            messageID: result.messageID,
            finish: result.finish,
            error: result.error ?? null,
            truncated: result.text.length > limit,
          },
        }
      } catch (error) {
        return { title: "subagent_result failed", output: `Failed to read messages: ${errorText(error)}` }
      }
    },
  })

  const cancelTool = tool({
    description:
      "Abort a running subagent session. Use to stop a background subagent that is " +
      "no longer needed (for example after another parallel subagent already " +
      "answered). Returns whether the abort was accepted.",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to abort."),
    },
    async execute(args) {
      const api = sessionApi(client)
      if (typeof api?.abort !== "function") {
        return { title: "subagent_cancel unavailable", output: "subagent_cancel unavailable: this OpenCode build exposes no session.abort SDK method." }
      }
      try {
        const accepted = unwrap(await api.abort({ path: { id: args.sessionID } }))
        return {
          title: `subagent_cancel · ${accepted ? "aborted" : "no-op"}`,
          output: accepted
            ? `Abort requested for ${args.sessionID}.`
            : `No running session to abort for ${args.sessionID}.`,
          metadata: { sessionID: args.sessionID, accepted: Boolean(accepted) },
        }
      } catch (error) {
        return { title: "subagent_cancel failed", output: `Failed to abort: ${errorText(error)}` }
      }
    },
  })

  const sendTool = tool({
    description:
      "Send additional context or instructions to a subagent session without " +
      "blocking. Uses the async prompt endpoint, so the parent is not held while " +
      "the child processes the message. Use to steer a long-running background " +
      "subagent (for example to narrow scope or supply a missing detail).",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to message."),
      prompt: tool.schema.string().describe("Text to queue into the subagent session."),
    },
    async execute(args) {
      const api = sessionApi(client)
      if (typeof api?.promptAsync !== "function") {
        return {
          title: "subagent_send unavailable",
          output: "subagent_send unavailable: this OpenCode build exposes no session.promptAsync SDK method.",
        }
      }
      if (!args.prompt) {
        return { title: "subagent_send · empty", output: "No prompt text provided." }
      }
      try {
        // Preserve the child's own agent/model. Without this, OpenCode resolves
        // the prompt against the default agent (e.g. orchestrator) and its model,
        // silently changing the subagent's identity.
        let target = {}
        let parentID
        if (typeof api?.get === "function") {
          try {
            const info = unwrap(await api.get({ path: { id: args.sessionID } }))
            target = resolveTarget(info)
            if (info && typeof info.parentID === "string" && info.parentID) parentID = info.parentID
          } catch {
            // Session lookup is best-effort; fall back to the child's defaults.
          }
        }
        await api.promptAsync({
          path: { id: args.sessionID },
          body: { parts: [{ type: "text", text: args.prompt }], ...target },
        })
        // Arm the one-shot completion notice: the child's next idle injects a
        // synthetic completion text into the parent, mirroring core's native
        // notice for the initial background dispatch.
        if (parentID) onSend?.(parentID, args.sessionID)
        const identity = target.agent ? ` as ${target.agent}` : ""
        return {
          title: "subagent_send · queued",
          output: `Queued ${args.prompt.length} char(s) into ${args.sessionID}${identity}.`,
          metadata: { sessionID: args.sessionID, ...target },
        }
      } catch (error) {
        return { title: "subagent_send failed", output: `Failed to send: ${errorText(error)}` }
      }
    },
  })

  return {
    tool: {
      subagent_children: childrenTool,
      subagent_result: resultTool,
      subagent_cancel: cancelTool,
      subagent_send: sendTool,
    },
    dispose: async () => {},
  }
}

/**
 * Read the SDK session status map, tolerating a missing `status` method.
 *
 * @param {object} api
 * @returns {Promise<Record<string, { type?: string }>>}
 */
async function readStatusMap(api) {
  if (typeof api?.status !== "function") return {}
  const map = unwrap(await api.status())
  return map && typeof map === "object" ? map : {}
}
