/**
 * OpenCode V2 plugin: opencode-asynchronous-agent
 *
 * OpenCode V2 has a keybind (ctrl+b / command "session.background") that moves a
 * running foreground subagent into background observation. This plugin applies
 * the same outcome automatically, at call time: whenever the parent agent
 * invokes the subagent tool, the hook forces `background: true` on the tool
 * input, so the child session is launched in the background and the parent
 * returns immediately with the "working in the background" notice instead of
 * blocking on it.
 *
 * Mechanism
 * ---------
 * `ctx.tool.hook("execute.before", cb)` runs before a tool executes and hands the
 * callback an OWNED, MUTABLE event. Replacing/mutating `event.input` changes the
 * arguments the tool actually executes with (the official V2 plugin docs say the
 * hook can "Inspect or replace tool input before execution"). OpenCode itself
 * relies on this: the built-in `opencode.tool.input.repair` plugin rewrites
 * `event.input` for every tool, and another built-in fixup rewrites
 * `event.input` for the subagent tool. Setting `event.input.background = true`
 * here is therefore enough to background the subagent.
 *
 * Version notes (verified against the running OpenCode v2.0.18 binary)
 * --------------------------------------------------------------------
 *  - The subagent tool id is "subagent" (older builds called it "task"). Both are
 *    matched here so the plugin keeps working across versions.
 *  - `background` is a first-class, always-available field of the subagent tool
 *    schema in v2.0.x; no experimental flag is required (only nested subagents
 *    are gated by `experimental.subagent_depth`).
 *
 * Configuration (all optional, via environment variables)
 * -------------------------------------------------------
 *   OPENCODE_AUTO_BG_SUBAGENT=0|false|off   Disable the plugin entirely.
 *   OPENCODE_AUTO_BG_AGENTS=a,b,c           Only background when the PARENT agent
 *                                           (the one calling the tool) is in
 *                                           this comma-separated list.
 *   OPENCODE_AUTO_BG_EXCEPT=x,y             Never background when the parent
 *                                           agent is in this list.
 *   OPENCODE_AUTO_BG_DEBUG=1                Log each rewrite to stderr.
 */

/** Stable plugin identifier reported to OpenCode V2. */
export const PLUGIN_ID = "opencode-asynchronous-agent"

/** Tool ids that spawn a child subagent session. */
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

/**
 * V2 setup entry point.
 *
 * @param {import("@opencode/plugin").Context} ctx
 */
export async function autoBackgroundSetup(ctx) {
  if (isDisabled()) return

  const debug = String(process.env.OPENCODE_AUTO_BG_DEBUG ?? "") === "1"

  const registration = await ctx.tool.hook("execute.before", (event) => {
    if (!event || !SUBAGENT_TOOLS.has(event.tool)) return

    const input = event.input
    if (input === null || typeof input !== "object") return
    if (input.background === true) return
    if (!agentAllowed(event.agent)) return

    input.background = true

    if (debug) {
      console.error(
        `[opencode-asynchronous-agent] backgrounded ${event.tool} ` +
          `(agent=${event.agent ?? "?"}, session=${event.sessionID ?? "?"})`,
      )
    }
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

export default autoBackgroundPlugin
