/**
 * OpenCode V1 + V2 plugin: opencode-asynchronous-agent
 *
 * Runs every subagent asynchronously (background) by default, so the parent
 * agent returns immediately instead of blocking on the subagent result.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * Both OpenCode V1 and V2 trigger the `tool.execute.before` hook for every tool
 * call and hand the callback a MUTABLE argument object:
 *
 *   V1:  "tool.execute.before"(input: { tool, sessionID, callID }, output: { args })
 *        — see packages/opencode/src/session/tools.ts (all tools) and
 *          packages/opencode/src/session/prompt.ts (the task tool).
 *   V2:  ctx.tool.hook("execute.before", event) with a mutable `event.input`.
 *
 * Mutating `args.background = true` on the subagent tool therefore launches the
 * child session in the background. The tool id is "task" on V1 (it was renamed
 * to "subagent" on V2), so both are matched here.
 *
 * ── Requirements ────────────────────────────────────────────────────────────
 * V1 gates background subagents behind an experimental flag. Enable it:
 *
 *   export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
 *
 * (or the umbrella `OPENCODE_EXPERIMENTAL=true`). Without the flag the task
 * tool rejects `background: true`; this plugin stays a harmless no-op in that
 * case, so enabling the flag is safe to do unconditionally.
 *
 * ── Configuration (all optional, via environment variables) ─────────────────
 *   OPENCODE_AUTO_BG_SUBAGENT=0|false|off   Disable the plugin entirely.
 *   OPENCODE_AUTO_BG_AGENTS=a,b,c           Only background when the PARENT agent
 *                                           (the one calling the tool) is in
 *                                           this comma-separated list.
 *   OPENCODE_AUTO_BG_EXCEPT=x,y             Never background when the parent
 *                                           agent is in this list.
 *   OPENCODE_AUTO_BG_DEBUG=1                Log each rewrite to stderr.
 *
 * ── Subagent status tool (opt-in) ───────────────────────────────────────────
 *   OPENCODE_SUBAGENT_STATUS=1              Register the `subagent_status` tool
 *                                           (running/done/error/stale tracking).
 *   OPENCODE_SUBAGENT_STALE_MS=120000       Age after which a still-running
 *                                           child is reported as stale.
 *
 * ── Subagent control tools (opt-in, V1 only) ────────────────────────────────
 * OpenCode's model is push-only, so the parent cannot inspect, cancel, or steer
 * background subagents. These tools close that gap via the public SDK:
 *
 *   subagent_children  list a parent's child sessions
 *   subagent_result    fetch a child's final assistant answer
 *   subagent_cancel    abort a running child
 *   subagent_send      queue extra context into a child (non-blocking)
 *
 * There is no subagent_wait: OpenCode already pushes a completion notice when a
 * child finishes, and a blocking wait is just polling in disguise.
 *
 *   OPENCODE_SUBAGENT_CONTROL=1             Register the control tools. Setting
 *                                           OPENCODE_SUBAGENT_STATUS=1 enables
 *                                           both suites.
 *   OPENCODE_SUBAGENT_RESULT_CHARS=20000    Cap for subagent_result output.
 *
 * ── Subagent progress reports (V1 only, on by default) ──────────────────────
 * A background child can publish progress to its parent as it works: on every
 * `todo.updated` (i.e. each `todowrite`) the plugin injects a short synthetic
 * report into the parent session. Reports are coalesced to at most one per child
 * per interval, capped per child, plus one final report when all todos are
 * terminal. Event-driven, never polled. The default channel is `chat` (hidden
 * part, no parent model turn); the TUI shows progress independently.
 *
 *   OPENCODE_SUBAGENT_NOTIFICATION_TYPE=..   Channel: toast | chat | inline |
 *                                            both | off (default chat).
 *   OPENCODE_SUBAGENT_PROGRESS=0             Disable progress reports.
 *   OPENCODE_SUBAGENT_PROGRESS_MS=300000     Min interval between reports per
 *                                            child (default 300000).
 *   OPENCODE_SUBAGENT_PROGRESS_MAX=5         Max non-final reports per child
 *                                            (default 5).
 *
 * ── Completion notices (V1 only, on by default) ─────────────────────────────
 * The plugin emulates the completion notice for `subagent_send` follow-ups. Its
 * channel is DECOUPLED from progress and defaults to `inline` (waking), so the
 * subagent -> main-agent notification is never silenced:
 *
 *   OPENCODE_SUBAGENT_COMPLETION_NOTIFY=..   Channel: toast | chat | inline |
 *                                            both | off (default inline).
 *
 * ── Database cleanup (opt-out, V1 only) ─────────────────────────────────────
 * OpenCode stores each session twice (projection tables + an event-sourcing
 * log) and persists tool results verbatim, so long-lived databases grow into
 * the multi-GB range. On the V1 entrypoint this plugin:
 *
 *   - caps oversized tool output and UI-only metadata at write time via
 *     `tool.execute.after`, and
 *   - periodically deletes `event` rows and trims `part` rows for sessions
 *     inactive past the retention window (never touching `event_sequence` or
 *     the session/message rows the model reads).
 *
 *   OPENCODE_DB_CLEANUP=0                   Disable cleanup entirely.
 *   OPENCODE_DB_CLEANUP_RETENTION_MS=...    Inactive age before pruning
 *                                           (default 259200000 = 3 days).
 *   OPENCODE_DB_CLEANUP_INTERVAL_MS=...     Minimum delay between prune passes
 *                                           (default 21600000 = 6 hours).
 *   OPENCODE_DB_CLEANUP_WAL_THRESHOLD=...   WAL size (bytes) above which a
 *                                           PASSIVE checkpoint runs, and above
 *                                           which an adaptive prune may run early
 *                                           (default 67108864 = 64 MiB).
 *   OPENCODE_DB_CLEANUP_WAL_IDLE_MS=...     Idle window (ms): with no write this
 *                                           recent, the governor TRUNCATEs the WAL
 *                                           (default 15000).
 *   OPENCODE_DB_CLEANUP_WAL_CHECK_MS=...    Spacing (ms) between WAL governor
 *                                           ticks (default 30000).
 *   OPENCODE_DB_CLEANUP_PRUNE_FLOOR_MS=...  Floor delay (ms) between adaptive
 *                                           prune passes (default 1800000 = 30m).
 *   OPENCODE_DB_CLEANUP_MAX_OUTPUT_CHARS=.. Cap for model-visible tool output
 *                                           (default 100000).
 *   OPENCODE_DB_CLEANUP_MAX_DIFF_CHARS=...  Cap for UI-only diff metadata
 *                                           (default 64000).
 *   OPENCODE_DB_CLEANUP_MAX_DIAGNOSTICS_CHARS=...
 *                                           Cap for the UI-only LSP diagnostics
 *                                           blob (default 32000; oversized
 *                                           blobs are emptied).
 *   OPENCODE_DB_CLEANUP_PART_PREVIEW_CHARS= Preview kept when trimming an old
 *                                           tool part (default 2000).
 *   OPENCODE_DB_CLEANUP_PART_BATCH=...      Max parts rewritten per pass
 *                                           (default 500).
 *   OPENCODE_DB_CLEANUP_VACUUM=1            Also VACUUM after a prune (needs
 *                                           exclusive DB access; opt-in).
 *   OPENCODE_DB_CLEANUP_DEBUG=1             Log prune activity to stderr.
 *
 * The tool is only registered on the V1 entrypoint, which is the only plugin
 * surface that supports custom-tool and event registration. On a V2-only build
 * the V2 entrypoint is a no-op (it cannot register tools); a dual V1+V2 build
 * registers everything through the V1 `server` entrypoint.
 */

import { createSubagentStatus, statusEnabled } from "./subagent-status.js"
import { controlEnabled, createSubagentControl } from "./subagent-control.js"
import { progressEnabled, createSubagentProgress } from "./subagent-progress.js"
import { completionEnabled, createSubagentCompletion } from "./subagent-completion.js"
import { cleanupEnabled, createCleanup } from "./cleanup.js"

/** Stable plugin identifier. */
export const PLUGIN_ID = "opencode-asynchronous-agent"

/** Tool ids that spawn a child subagent session (V1 "task", V2 "subagent"). */
const SUBAGENT_TOOLS = new Set(["subagent", "task"])

function isDisabled() {
  const v = String(process.env.OPENCODE_AUTO_BG_SUBAGENT ?? "").trim().toLowerCase()
  return v === "0" || v === "false" || v === "off" || v === "no"
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function agentAllowed(parentAgent) {
  const allow = parseList(process.env.OPENCODE_AUTO_BG_AGENTS)
  const deny = parseList(process.env.OPENCODE_AUTO_BG_EXCEPT)
  const id = String(parentAgent ?? "")
  if (deny.includes(id)) return false
  if (allow.length > 0 && !allow.includes(id)) return false
  return true
}

function isObject(value) {
  return Boolean(value) && typeof value === "object"
}

const debugEnabled = () => String(process.env.OPENCODE_AUTO_BG_DEBUG ?? "") === "1"

/**
 * Values OpenCode (Effect `Config.boolean`) accepts as a boolean, case-sensitive.
 * Anything else makes the flag parse fail and fall back to its default (`false`).
 */
const TRUE_VALUES = new Set(["true", "yes", "on", "1", "y"])
const FALSE_VALUES = new Set(["false", "no", "off", "0", "n"])

/**
 * Whether the running OpenCode build allows `background: true` on a subagent
 * tool call.
 *
 * OpenCode V2 always supports it. OpenCode V1 gates it behind
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, falling back to
 * `OPENCODE_EXPERIMENTAL` when the former is unset/unparseable. Injecting the
 * flag without support makes the whole subagent call fail with
 * "Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true",
 * so we must not inject it unless it is enabled.
 */
function backgroundSupported() {
  const direct = String(process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ?? "")
  if (TRUE_VALUES.has(direct)) return true
  if (FALSE_VALUES.has(direct)) return false
  return TRUE_VALUES.has(String(process.env.OPENCODE_EXPERIMENTAL ?? ""))
}

/**
 * Apply `background: true` to a subagent tool call. Shared by the V1 and V2
 * hooks. V2 always supports background subagents; the V1 entry point refuses to
 * register this hook at all when its experimental flag is missing, so no flag
 * check is needed here.
 */
function backgroundSubagent(tool, args, parentAgent, sessionID, debug) {
  if (!SUBAGENT_TOOLS.has(tool)) return
  if (!isObject(args)) return
  if (args.background === true) return
  if (!agentAllowed(parentAgent)) return

  args.background = true

  if (debug) {
    console.error(
      `[opencode-asynchronous-agent] backgrounded ${tool} ` +
        `(agent=${parentAgent ?? "?"}, session=${sessionID ?? "?"})`,
    )
  }
}

/**
 * OpenCode V1 entry point. Receives the V1 `PluginInput` and returns a `Hooks`
 * object. V1 does not pass the calling agent to `tool.execute.before`, so this
 * entrypoint learns the parent agent from the `chat.message` hook (keyed by
 * session id) and uses it to apply the allow/deny list.
 *
 * @param {import("@opencode-ai/plugin").PluginInput} ctx
 */
export async function autoBackgroundPluginV1(ctx) {
  if (isDisabled()) return {}

  const directory = ctx?.directory ?? process.cwd()
  const supported = backgroundSupported()

  /** Periodic WAL-governor timer (cleared on dispose). */
  let walTimer

  // V1's `tool.execute.before` omits the calling agent, so remember the agent
  // per session from `chat.message` (which does carry it) to make
  // OPENCODE_AUTO_BG_AGENTS / OPENCODE_AUTO_BG_EXCEPT work on V1.
  const sessionAgents = new Map()

  // Opt-in status tool. Independent of the background flag: it tracks child
  // sessions from plugin events and reports running/done/error/stale.
  const status = statusEnabled() ? createSubagentStatus({ client: ctx?.client, directory }) : undefined

  // Emulated completion notice for `subagent_send` follow-ups: records the
  // child->parent linkage when a follow-up is queued, then delivers one
  // completion notice into the parent on the child's next idle. Gated by its own
  // channel switch (`OPENCODE_SUBAGENT_COMPLETION_NOTIFY`), which defaults to
  // `inline` (waking) and is DECOUPLED from the progress channel; it is
  // independent of the progress feature so setting the completion channel alone
  // still constructs it.
  const completion = completionEnabled() ? createSubagentCompletion({ client: ctx?.client }) : undefined

  // Opt-in control tools: list/result/cancel/send for background children. The
  // send path arms the completion notice so a follow-up is announced on idle.
  const control = controlEnabled() ? createSubagentControl({ client: ctx?.client, onSend: completion?.onSend }) : undefined

  // Opt-in progress reports: inject coalesced todo-based progress from a child
  // into its parent as the child works (event-driven, never polled).
  const progress = progressEnabled() ? createSubagentProgress({ client: ctx?.client }) : undefined

  // Database cleanup (opt-out): caps tool results at write time and prunes
  // old event/part rows on a throttled schedule.
  const cleanup = cleanupEnabled() ? createCleanup() : undefined

  if (debugEnabled()) {
    console.error(
      `[opencode-asynchronous-agent] V1 hook active (dir=${directory}, ` +
        `backgroundSupported=${supported}, statusTool=${Boolean(status)}, ` +
        `controlTools=${Boolean(control)}, progress=${Boolean(progress)}, ` +
        `completion=${Boolean(completion)}, cleanup=${Boolean(cleanup)})`,
    )
  }

  const hooks = {}

  if (status) hooks.tool = status.tool
  if (control) hooks.tool = { ...hooks.tool, ...control.tool }

  // Record the agent for each session so the background filter can resolve it
  // later; `chat.message` is the only V1 hook that carries the agent.
  if (supported || status || control) {
    hooks["chat.message"] = async (input) => {
      if (input && typeof input.sessionID === "string" && typeof input.agent === "string" && input.agent) {
        sessionAgents.set(input.sessionID, input.agent)
      }
    }
  }

  // The `event` hook fans out to every subscriber; compose status + progress + completion + cleanup.
  const eventSubscribers = [status?.event, progress?.event, completion?.event, cleanup?.event].filter(Boolean)
  if (eventSubscribers.length > 0) {
    hooks.event = async (input) => {
      for (const subscriber of eventSubscribers) await subscriber(input)
    }
  }

  const disposers = [status?.dispose, control?.dispose, progress?.dispose, completion?.dispose, cleanup?.dispose].filter(Boolean)
  if (disposers.length > 0) {
    hooks.dispose = async () => {
      if (walTimer) {
        clearInterval(walTimer)
        walTimer = undefined
      }
      for (const dispose of disposers) await dispose()
      sessionAgents.clear()
    }
  }

  if (cleanup) {
    hooks["tool.execute.after"] = async (input, output) => {
      cleanup.cap(input, output)
    }
    // Periodic WAL governor tick: the event fan-out covers active writes, but a
    // fully idle process emits no events, so a timer guarantees the quiescent
    // TRUNCATE path still runs. unref() keeps it from holding the process open.
    walTimer = setInterval(() => {
      try {
        cleanup.walGovern()
      } catch {
        // best-effort: a governor failure must never crash the plugin
      }
    }, cleanup.limits.walCheckMs)
    walTimer.unref?.()
  }

  // Inject a "keep todowrite current" instruction into child sessions only, so
  // progress reports have an event stream to react to.
  if (progress) {
    hooks["experimental.chat.system.transform"] = async (input, output) => {
      await progress.systemTransform(input, output)
    }
  }

  if (!supported) {
    console.error(
      "[opencode-asynchronous-agent] background subagents are disabled by this " +
        "OpenCode build: set OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true " +
        "(or OPENCODE_EXPERIMENTAL=true) before starting OpenCode to enable them. " +
        "Subagents will run in the foreground until then.",
    )
    return hooks
  }

  hooks["tool.execute.before"] = async (input, output) => {
    const parentAgent = input?.agent ?? sessionAgents.get(input?.sessionID)
    backgroundSubagent(input?.tool, output?.args, parentAgent, input?.sessionID, debugEnabled())
  }

  return hooks
}

/**
 * OpenCode V2 entry point. Receives the V2 `Context` and registers a mutable
 * `execute.before` tool hook.
 *
 * @param {import("@opencode/plugin").Context} ctx
 */
export async function autoBackgroundSetup(ctx) {
  if (isDisabled()) return

  // The V2 plugin host (`@opencode-ai/plugin/v2/promise` `PluginContext`) exposes
  // only transform hooks (agent/catalog/command/integration/reference/skill/aisdk)
  // and a plugin domain, so a V2-only build cannot register a tool hook or event
  // handler. On a dual V1+V2 build the V1 `server` entrypoint does this work; here
  // we no-op instead of throwing, which keeps the V2 loader quiet.
  if (typeof ctx?.tool?.hook !== "function") {
    if (debugEnabled()) {
      console.error(
        "[opencode-asynchronous-agent] this build's V2 plugin API exposes no tool hooks; " +
          "background subagents are handled by the V1 entrypoint.",
      )
    }
    return
  }

  const debug = debugEnabled()

  const registration = await ctx.tool.hook("execute.before", (event) => {
    if (!event) return
    backgroundSubagent(event.tool, event.input, event.agent, event.sessionID, debug)
  })

  // OpenCode V2 calls the returned cleanup on unload/dispose.
  return async () => {
    try {
      await registration?.dispose?.()
    } catch {
      // best-effort disposal
    }
  }
}

/** OpenCode V2 plugin definition (default export contract). */
export const autoBackgroundPlugin = {
  id: PLUGIN_ID,
  setup: autoBackgroundSetup,
}

/**
 * Dual V1 + V2 default export.
 *
 *   - OpenCode V1 (1.18.29+) reads the legacy `server` field and calls it with
 *     the V1 `PluginInput`.
 *   - OpenCode V2 (>= 2.0.x) reads `id` / `setup` and calls `setup(ctx)`.
 */
export default {
  id: PLUGIN_ID,
  setup: autoBackgroundSetup,
  server: autoBackgroundPluginV1,
}
