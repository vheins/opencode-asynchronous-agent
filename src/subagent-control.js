/**
 * Background-subagent control tools for the OpenCode V1 plugin entrypoint.
 *
 * OpenCode's model is push-only: the parent is notified when a background child
 * finishes, but it cannot list children, fetch a child's result on demand, cancel
 * one, or send it extra context. These tools close that gap on top of the public
 * SDK (`PluginInput.client`):
 *
 *   - `subagent_children` — list a parent's child sessions
 *   - `subagent_result`   — fetch a child's answer, live activity, or history
 *   - `subagent_cancel`   — abort a running child
 *   - `subagent_send`     — queue extra context into a LIVE child
 *   - `subagent_watch`    — wait (briefly, bounded) for a child's status/activity
 *                           to CHANGE
 *
 * There is deliberately no `subagent_wait`: blocking until a child finishes
 * defeats the asynchronous model. OpenCode already pushes a completion notice to
 * the parent when a child finishes. `subagent_watch` only observes a state
 * transition inside a short hard-capped window.
 *
 * When a status registry (`createSubagentStatus`) is supplied, it is the single
 * source of truth for a child's liveness: the control tools read classified
 * status from it and fall back to the SDK only for sessions it does not track.
 * Without a registry the tools still work standalone from the SDK alone.
 *
 * The tool suite is assembled from focused modules and this file only wires
 * them together: `./subagent-children-tool.js` and `./subagent-result-tool.js`
 * own their tool definitions, `./subagent-rows.js` owns the child-row
 * projection, and `./subagent-summarize.js` owns the transcript helpers
 * (`extractResult`, `summarizeActivity`, `summarizeHistory`, `clampText`,
 * `sliceAfterCursor`). All public exports are re-exported here so this module's
 * surface stays stable.
 *
 * Every tool is non-destructive, degrades gracefully when an SDK method is
 * unavailable, and is disposed on unload.
 *
 * Opt-in via `OPENCODE_SUBAGENT_CONTROL=1`; setting `OPENCODE_SUBAGENT_STATUS=1`
 * enables both the status tool and this suite.
 *
 * @module subagent-control
 */

import { tool } from "@opencode-ai/plugin"

// `unwrap` and `resolveTarget` are dependency-free helpers shared with the core
// hook and the progress/completion modules.
import { resolveTarget, sessionApi, unwrap } from "./subagent-utils.js"
import { createRowBuilders, errorText } from "./subagent-rows.js"
import { createChildrenTool } from "./subagent-children-tool.js"
import { createResultTool } from "./subagent-result-tool.js"

export { controlEnabled, resolveTarget, unwrap } from "./subagent-utils.js"
export {
  clampText,
  extractResult,
  isAnswerPart,
  sliceAfterCursor,
  summarizeActivity,
  summarizeHistory,
} from "./subagent-summarize.js"
export {
  DEFAULT_CHILDREN_LIMIT,
  errorText,
  formatActivity,
  mapSdkStatus,
  percentOf,
  pickStatus,
} from "./subagent-rows.js"

/** Default maximum characters returned by `subagent_result`. */
export const DEFAULT_RESULT_CHARS = 20000

/** Default `subagent_watch` window (ms). */
export const DEFAULT_WATCH_MS = 15000

/** Hard cap for `subagent_watch` (ms), so it can never block for long. */
export const DEFAULT_WATCH_MAX_MS = 30000

/** Poll interval used by `subagent_watch` (ms). */
export const WATCH_INTERVAL_MS = 100

/** Statuses that mean the child is no longer safe to prompt. */
const NON_LIVE = new Set(["done", "error", "stale", "dead"])

/** A stable identity for "status + activity" used by `subagent_watch`. */
function fingerprint(item) {
  return item ? `${item.status}:${item.activity}` : "unknown"
}

/**
 * Derive an activity label when the registry does not know the child.
 *
 * @param {{ inFlight: Array<unknown> }} activity
 * @param {boolean} streaming
 * @returns {"tool" | "streaming" | "idle"}
 */
function deriveActivity(activity, streaming) {
  if (activity.inFlight.length > 0) return "tool"
  return streaming ? "streaming" : "idle"
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
 * Create the control tool suite.
 *
 * @param {{
 *   client?: object,
 *   registry?: {
 *     get: (sessionID: string) => object | undefined,
 *     classify: (sessionID: string) => string | undefined,
 *     snapshot: (filter?: object) => object[],
 *   },
 *   resultChars?: number,
 *   onSend?: (parentID: string, childID: string) => void,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   watchMaxMs?: number,
 * }} [options]
 * @returns {{ tool: Record<string, unknown>, dispose: () => Promise<void> }}
 */
export function createSubagentControl(options = {}) {
  const client = options.client
  const registry = options.registry
  const resultChars = options.resultChars ?? envInt("OPENCODE_SUBAGENT_RESULT_CHARS", DEFAULT_RESULT_CHARS)
  const onSend = typeof options.onSend === "function" ? options.onSend : undefined
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const sleep =
    typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const watchMaxMs = Number.isFinite(options.watchMaxMs)
    ? Math.max(0, Math.floor(options.watchMaxMs))
    : envInt("OPENCODE_SUBAGENT_WATCH_MAX_MS", DEFAULT_WATCH_MAX_MS)

  const { sdkRow, registryRow } = createRowBuilders({ registry, now })

  /**
   * Classified status for a session from the registry, or `undefined` when the
   * registry does not track it (or no registry was supplied).
   *
   * @param {string} sessionID
   * @returns {{ status: string, item?: object } | undefined}
   */
  function lookup(sessionID) {
    if (!registry || typeof registry.get !== "function") return undefined
    const item = registry.get(sessionID)
    if (!item) return undefined
    return { status: item.status, item }
  }

  const childrenTool = createChildrenTool({ client, registry, sdkRow, registryRow })
  const resultTool = createResultTool({ client, resultChars, now, lookup, deriveActivity })

  const cancelTool = tool({
    description:
      "Abort a running subagent session. Use to stop a background subagent that is " +
      "no longer needed (for example after another parallel subagent already " +
      "answered, or one reported dead). Returns whether the abort was accepted.",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to abort."),
    },
    async execute(args) {
      const api = sessionApi(client)
      if (typeof api?.abort !== "function") {
        return {
          title: "subagent_cancel unavailable",
          output: "subagent_cancel unavailable: this OpenCode build exposes no session.abort SDK method.",
        }
      }
      try {
        const accepted = unwrap(await api.abort({ path: { id: args.sessionID } }))
        // A void/undefined return from a successful abort is success: only an
        // explicit `false` means the build refused the request.
        const ok = accepted !== false
        return {
          title: `subagent_cancel · ${ok ? "aborted" : "no-op"}`,
          output: ok
            ? `Abort requested for ${args.sessionID}.`
            : `No running session to abort for ${args.sessionID}.`,
          metadata: { sessionID: args.sessionID, accepted: ok },
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
      "the child processes the message. Refuses to queue into a finished, errored, " +
      "stale, or dead child (cancel and re-dispatch instead); pass `force: true` to " +
      "override.",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to message."),
      prompt: tool.schema.string().describe("Text to queue into the subagent session."),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Queue even when the child is done/error/stale/dead."),
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
      const tracked = lookup(args.sessionID)
      if (tracked && !args.force && NON_LIVE.has(tracked.status)) {
        return {
          title: `subagent_send · refused (${tracked.status})`,
          output:
            `${args.sessionID} is ${tracked.status}, so queuing a message would be lost. ` +
            `Use subagent_cancel to clear it and re-dispatch, or pass force: true to send anyway.`,
          metadata: { sessionID: args.sessionID, refused: true, status: tracked.status },
        }
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

  const watchTool = tool({
    description:
      "Watch a subagent for a state CHANGE (status or activity), bounded by a short " +
      "timeout. This is NOT a completion wait: it reads the in-memory status registry " +
      "and returns as soon as the child's status/activity changes from the baseline, " +
      "or when the timeout elapses. Never blocks longer than the hard cap " +
      "(OPENCODE_SUBAGENT_WATCH_MAX_MS, default 30s).",
    args: {
      sessionID: tool.schema.string().describe("Subagent session id to watch."),
      timeoutMs: tool.schema
        .number()
        .optional()
        .describe("How long to wait for a change (default 15000, capped by the hard max)."),
    },
    async execute(args) {
      if (!registry || typeof registry.get !== "function") {
        return {
          title: "subagent_watch unavailable",
          output: "subagent_watch unavailable: no status registry is active (enable OPENCODE_SUBAGENT_STATUS).",
        }
      }
      const requested =
        Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : DEFAULT_WATCH_MS
      const budget = Math.min(requested, watchMaxMs)
      const baselineItem = registry.get(args.sessionID)
      const baseline = fingerprint(baselineItem)
      const startedAt = now()
      // Bound the tick count as well as the clock: a fake clock that never
      // advances must not turn this into an infinite loop.
      const maxTicks = Math.ceil(budget / WATCH_INTERVAL_MS) + 2
      let item = baselineItem
      let changed = false
      let ticks = 0
      while (ticks < maxTicks) {
        ticks += 1
        item = registry.get(args.sessionID)
        if (fingerprint(item) !== baseline) {
          changed = true
          break
        }
        const elapsed = now() - startedAt
        if (elapsed >= budget) break
        await sleep(Math.min(WATCH_INTERVAL_MS, budget - elapsed))
      }
      const elapsedMs = Math.max(0, now() - startedAt)
      const status = item?.status ?? "unknown"
      const activity = item?.activity ?? null
      const summary = changed
        ? `${args.sessionID} changed to ${status} (activity=${activity ?? "?"}) after ${elapsedMs}ms.`
        : `${args.sessionID} unchanged at ${status} (activity=${activity ?? "?"}) after ${elapsedMs}ms; timed out.`
      return {
        title: `subagent_watch · ${changed ? "changed" : "timeout"}`,
        output: summary,
        metadata: { sessionID: args.sessionID, changed, status, activity, elapsedMs, timedOut: !changed, baseline },
      }
    },
  })

  const tools = {
    subagent_children: childrenTool,
    subagent_result: resultTool,
    subagent_cancel: cancelTool,
    subagent_send: sendTool,
  }
  if (registry) tools.subagent_watch = watchTool

  return {
    tool: tools,
    dispose: async () => {},
  }
}

