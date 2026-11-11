/**
 * The `subagent_children` control tool.
 *
 * A triage list, not an SDK dump: live children first, one identity line plus
 * one detail line each, under an aggregate header. Registry rows cost zero SDK
 * calls; SDK rows cost exactly two (`children` + `status`) regardless of how
 * many children there are.
 *
 * @module subagent-children-tool
 */

import { tool } from "@opencode-ai/plugin"
import { sessionApi, unwrap } from "./subagent-utils.js"
import { renderChildHeader, renderChildLines, statusRank } from "./subagent-format.js"
import { DEFAULT_CHILDREN_LIMIT, countRows, errorText, readStatusMap } from "./subagent-rows.js"

/**
 * Build the `subagent_children` tool.
 *
 * A triage list, not an SDK dump: live children first, one identity line plus
 * one detail line each, with an aggregate header. `sessionID` is optional so a
 * model that does not know its own session id can still list tracked children.
 *
 * @param {{
 *   client?: object,
 *   registry?: { snapshot?: () => object[] },
 *   sdkRow: (info: object, statusMap: Record<string, { type?: string }>) => object,
 *   registryRow: (item: object) => object,
 * }} deps
 * @returns {object}
 */
export function createChildrenTool(deps) {
  const { client, registry, sdkRow, registryRow } = deps
  return tool({
    description:
      "List child (subagent) sessions with a triage view: status, elapsed time, current " +
      "activity, todo progress, tool-call count, and context usage. Live work sorts first. " +
      "Omit sessionID to list every tracked child (requires OPENCODE_SUBAGENT_STATUS). " +
      "Supports `status` filtering, `limit`, and `verbose`.",
    args: {
      sessionID: tool.schema
        .string()
        .optional()
        .describe("Parent session id whose children to list. Omit to list all tracked children."),
      status: tool.schema
        .enum(["running", "stale", "dead", "done", "error", "unknown"])
        .optional()
        .describe("Only list children in this status."),
      limit: tool.schema
        .number()
        .optional()
        .describe("Maximum children to list (default 20, max 100)."),
      verbose: tool.schema
        .boolean()
        .optional()
        .describe("Add parent/session ids, progress clocks, and per-tool counts."),
    },
    async execute(args) {
      const parent = typeof args.sessionID === "string" && args.sessionID ? args.sessionID : undefined
      const statusFilter = typeof args.status === "string" && args.status ? args.status : undefined
      const limit = Number.isFinite(args.limit)
        ? Math.min(100, Math.max(1, Math.floor(args.limit)))
        : DEFAULT_CHILDREN_LIMIT
      const verbose = args.verbose === true

      let rows
      if (!parent) {
        // No parent id: fall back to everything the registry tracks.
        if (!registry || typeof registry.snapshot !== "function") {
          return {
            title: "subagent_children · needs a target",
            output:
              "Provide a sessionID, or enable the status registry (OPENCODE_SUBAGENT_STATUS=1) " +
              "to list all tracked children.",
          }
        }
        rows = registry.snapshot().map((item) => registryRow(item))
      } else {
        const api = sessionApi(client)
        if (typeof api?.children !== "function") {
          return {
            title: "subagent_children unavailable",
            output:
              "subagent_children unavailable: this OpenCode build exposes no " +
              "session.children SDK method.",
          }
        }
        try {
          const sessions = unwrap(await api.children({ path: { id: parent } }))
          const list = Array.isArray(sessions) ? sessions : []
          const statusMap = await readStatusMap(api)
          rows = list.map((info) => sdkRow(info, statusMap))
        } catch (error) {
          return { title: "subagent_children failed", output: `Failed to list children: ${errorText(error)}` }
        }
      }

      const filtered = statusFilter ? rows.filter((row) => row.status === statusFilter) : rows
      filtered.sort(
        (a, b) =>
          statusRank(a.status) - statusRank(b.status) ||
          (a.startedAt ?? a.updated ?? 0) - (b.startedAt ?? b.updated ?? 0) ||
          String(a.sessionID).localeCompare(String(b.sessionID)),
      )
      const visible = filtered.slice(0, limit)
      const truncated = filtered.length > visible.length
      const counts = countRows(filtered)

      const lines = []
      if (filtered.length === 0) {
        lines.push(parent ? `0 children of ${parent}.` : "No children tracked.")
      } else {
        lines.push(renderChildHeader(filtered))
        lines.push("")
        lines.push(...renderChildLines(visible, { verbose }))
        if (truncated) lines.push(`… +${filtered.length - visible.length} more (limit=${limit})`)
      }
      return {
        title: `subagent_children · ${visible.length}`,
        output: lines.join("\n"),
        metadata: { children: visible, counts, truncated },
      }
    },
  })
}
