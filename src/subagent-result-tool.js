/**
 * The `subagent_result` control tool.
 *
 * Reads a child's transcript once and answers three questions from it: the final
 * answer (`view: result`), what the child is doing right now (`view: activity`),
 * and a compact transcript (`view: history`). `view: auto` returns activity while
 * the child is live, so asking a working child for its result is never a dead
 * end. `sinceMessageID` acts as a read cursor so a polling caller only receives
 * new messages.
 *
 * @module subagent-result-tool
 */

import { tool } from "@opencode-ai/plugin"
import { sessionApi, unwrap } from "./subagent-utils.js"
import {
  clampText,
  extractResult,
  sliceAfterCursor,
  summarizeActivity,
  summarizeHistory,
} from "./subagent-summarize.js"
import { usedTokens } from "./subagent-format.js"
import { errorText, formatActivity, mergeActivity, percentOf } from "./subagent-rows.js"

/**
 * Build the `subagent_result` tool.
 *
 * One `session.messages` call answers three different questions: the final
 * answer (`view: result`), what the child is doing right now (`view: activity`),
 * and a compact transcript (`view: history`). `view: auto` picks activity while
 * the child is live, so a working child is never a dead end. A finished child
 * with nothing to say still returns the plain empty-session message.
 *
 * @param {{
 *   client?: object,
 *   resultChars: number,
 *   now: () => number,
 *   lookup: (sessionID: string) => { status: string, item?: object } | undefined,
 *   deriveActivity: (activity: object, streaming: boolean) => string,
 * }} deps
 * @returns {object}
 */
export function createResultTool(deps) {
  const { client, resultChars, now, lookup, deriveActivity } = deps
  return tool({
      description:
        "Fetch a subagent session's answer, live activity, or transcript. `view: auto` " +
        "(default) returns the final answer when the child has finished, and a live " +
        "activity report (in-flight tool, current todo, latest text) when it is still " +
        "working. Use `view: activity` to ask what it is doing right now, `view: history` " +
        "for a compact transcript, or `view: result` for just the final answer. Supports " +
        "`sinceMessageID` as a read cursor.",
      args: {
        sessionID: tool.schema.string().describe("Subagent session id to read."),
        maxChars: tool.schema
          .number()
          .optional()
          .describe("Maximum characters of the answer to return (default 20000)."),
        sinceMessageID: tool.schema
          .string()
          .optional()
          .describe("Only consider messages after this message id (from a prior nextCursor)."),
        view: tool.schema
          .enum(["auto", "result", "activity", "history"])
          .optional()
          .describe("What to return: auto (default), final result, live activity, or transcript history."),
        limit: tool.schema
          .number()
          .optional()
          .describe("For view=history: how many recent messages to render (default 20, max 100)."),
      },
      async execute(args) {
        const api = sessionApi(client)
        if (typeof api?.messages !== "function") {
          return {
            title: "subagent_result unavailable",
            output:
              "subagent_result unavailable: this OpenCode build exposes no " +
              "session.messages SDK method.",
          }
        }
        try {
          const messages = unwrap(await api.messages({ path: { id: args.sessionID } }))
          const all = Array.isArray(messages) ? messages : []
          const tracked = lookup(args.sessionID)
          const status = tracked?.status ?? "unknown"
          const inFlightTool = Boolean(tracked?.item?.activeTool)
          const streaming = status === "running" || status === "stale" || inFlightTool
          const limit = Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.floor(args.maxChars) : resultChars

          // The result view is cursor-aware; activity/history read the full list.
          const windowed = sliceAfterCursor(all, args.sinceMessageID)
          const result = extractResult(windowed)
          const lastSeen = windowed.length ? windowed[windowed.length - 1]?.info?.id : undefined
          const nextCursor = result.messageID ?? lastSeen ?? args.sinceMessageID

          const requested = args.view ?? "auto"
          // auto: a child known to be in motion gets a live activity report, so it
          // is never a dead end. Anything else (finished, dead, or unknown with
          // nothing to show) falls through to `result`, which owns the genuine
          // empty-session message.
          //
          // `dead` counts as terminal. A dead child is not working, so answering
          // `auto` with an activity report would hide its death behind a
          // "working" narrative; the result view plus a dead notice is honest.
          const live = streaming || status === "running" || status === "stale"
          const view = requested === "auto" ? (live ? "activity" : "result") : requested

          // The SDK list is authoritative for content, the registry for liveness.
          // Merge so the rendered text and the metadata never disagree.
          const activity = mergeActivity(summarizeActivity(windowed, { now }), tracked?.item)
          const stats = activity.stats ?? {}
          const baseMeta = {
            sessionID: args.sessionID,
            slug: tracked?.item?.slug,
            view,
            status,
            streaming,
            partial: streaming && !result.finish,
            activity: tracked?.item?.activity ?? deriveActivity(activity, streaming),
            activeTool:
              tracked?.item?.activeTool ??
              (activity.inFlight[0]
                ? { tool: activity.inFlight[0].tool, runningMs: activity.inFlight[0].runningMs }
                : null),
            todos: activity.todos,
            inFlight: activity.inFlight.length,
            // Cost/statistics come from the same event-derived shape the status
            // registry exposes, so both tools report identical numbers.
            model: tracked?.item?.model ?? stats.model,
            tokens: tracked?.item?.tokens ?? stats.tokens,
            contextUsed: tracked?.item?.contextUsed ?? usedTokens(stats.tokens),
            contextPercent: tracked?.item?.contextPercent ?? percentOf(stats.tokens, stats.contextLimit),
            toolCalls: tracked?.item?.toolCalls ?? stats.toolCalls ?? 0,
            toolErrors: tracked?.item?.toolErrors ?? stats.toolErrors ?? 0,
            lastActivity: tracked?.item?.lastActivity ?? activity.lastActivity,
            lastActivityAt: tracked?.item?.lastActivityAt ?? activity.lastActivityAt,
            sinceLastActivityMs: tracked?.item?.sinceLastActivityMs ?? activity.sinceLastActivityMs,
            sinceLastProgressMs: tracked?.item?.sinceLastProgressMs,
          }

          if (view === "activity") {
            return {
              title: `subagent_result · activity (${status})`,
              output: formatActivity(args.sessionID, activity, status),
              metadata: { ...baseMeta, nextCursor, found: result.found },
            }
          }

          if (view === "history") {
            // `windowed` already applied the cursor, so do not pass it twice.
            const history = summarizeHistory(windowed, { limit: args.limit, maxChars: resultChars })
            const text = history || "(no transcript yet)"
            return {
              title: `subagent_result · history (${status})`,
              output: clampText(text, resultChars),
              metadata: { ...baseMeta, nextCursor, truncated: text.length > resultChars },
            }
          }

          // view === "result": today's behaviour, plus the richer metadata.
          const dead = status === "dead"
          const deadNotice =
            `[dead] ${args.sessionID} appears dead (no progress, absent from the runtime). ` +
            `Inspect with view: "history", then subagent_cancel and re-dispatch if it is wedged.`
          if (!result.found && !result.error) {
            // Genuine dead end only when nothing is running: a live child already
            // routed to the activity view above.
            return {
              title: "subagent_result · empty",
              output: [dead ? deadNotice : undefined, `No assistant answer found for ${args.sessionID} (status=${status}).`]
                .filter(Boolean)
                .join("\n"),
              metadata: { ...baseMeta, found: false, nextCursor },
            }
          }
          const parts = []
          if (dead) parts.push(deadNotice)
          if (streaming && !result.finish) {
            parts.push(
              `[partial] ${args.sessionID} is still working (status=${status}); ` +
                `this answer may change. Poll again with sinceMessageID=${JSON.stringify(nextCursor)}.`,
            )
          }
          parts.push(clampText(result.text, limit))
          if (result.error) parts.push(`[error] ${errorText(result.error)}`)
          if (result.finish) parts.push(`[finish] ${result.finish}`)
          return {
            title: `subagent_result · ${result.found ? (streaming && !result.finish ? "partial" : "ok") : "error"}`,
            output: parts.join("\n"),
            metadata: {
              ...baseMeta,
              messageID: result.messageID,
              nextCursor,
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
}
