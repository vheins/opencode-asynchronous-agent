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
 */

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

/** Apply `background: true` to a subagent tool call. Shared by the V1 and V2 hooks. */
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
 * object. V1 does not pass the calling agent to `tool.execute.before`, so the
 * agent allow/deny list cannot filter on the parent agent here; the session id
 * is still available for debug logging.
 *
 * @param {import("@opencode-ai/plugin").PluginInput} ctx
 */
export async function autoBackgroundPluginV1(ctx) {
  if (isDisabled()) return {}

  const directory = ctx?.directory ?? process.cwd()
  if (debugEnabled()) {
    console.error(`[opencode-asynchronous-agent] V1 hook active (dir=${directory})`)
  }

  return {
    "tool.execute.before": async (input, output) => {
      backgroundSubagent(input?.tool, output?.args, input?.agent, input?.sessionID, debugEnabled())
    },
  }
}

/**
 * OpenCode V2 entry point. Receives the V2 `Context` and registers a mutable
 * `execute.before` tool hook.
 *
 * @param {import("@opencode/plugin").Context} ctx
 */
export async function autoBackgroundSetup(ctx) {
  if (isDisabled()) return

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
