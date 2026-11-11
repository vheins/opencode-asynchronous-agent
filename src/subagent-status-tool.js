/**
 * The `subagent_status` tool definition.
 *
 * Split out of `./subagent-status.js` so the registry (event ingestion, SDK
 * reconciliation, eviction) and the model-facing tool stay separately
 * readable. The tool is a thin shell: it calls the registry's `report()` and
 * renders the result with the shared formatter, so liveness logic has exactly
 * one home.
 *
 * @module subagent-status-tool
 */

import { tool } from "@opencode-ai/plugin"
import { formatReport } from "./subagent-liveness.js"

/** Custom tool id exposed to the model. */
export const STATUS_TOOL_ID = "subagent_status"

/**
 * Build the `subagent_status` tool.
 *
 * @param {(filter?: { parent?: string, status?: string }) => Promise<{
 *   items: object[],
 *   counts: object,
 *   staleThresholdMs: number,
 *   deadThresholdMs: number,
 *   toolGraceMs: number,
 * }>} report
 * @returns {object}
 */
export function createStatusTool(report) {
  return tool({
    description:
      "Report the status of background subagent sessions spawned by this session. " +
      "Each subagent is classified as running, stale (no progress within the stale " +
      "threshold), dead (no progress within the dead threshold — likely hung), done, " +
      "or error. An in-flight tool call (for example a long build) keeps a child " +
      "running for up to the tool-grace window. Returns parent linkage, elapsed time, " +
      "time since the last progress, and an actionable next step for non-terminal children.",
    args: {
      parent: tool.schema
        .string()
        .optional()
        .describe("Only report subagents whose parent session id equals this value."),
      status: tool.schema
        .enum(["running", "stale", "dead", "done", "error"])
        .optional()
        .describe("Only report subagents currently in this status."),
    },
    async execute(args) {
      const { items, counts, staleThresholdMs: staleMs, deadThresholdMs: deadMs, toolGraceMs: graceMs } =
        await report(args ?? {})
      return {
        title: `Subagents · ${counts.total} tracked`,
        output: formatReport(items, counts, { staleMs, deadMs, toolGraceMs: graceMs }),
        metadata: {
          subagents: items,
          counts,
          staleThresholdMs: staleMs,
          deadThresholdMs: deadMs,
          toolGraceMs: graceMs,
        },
      }
    },
  })
}
