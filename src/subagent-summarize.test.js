import { expect, test } from "bun:test"
import {
  DEFAULT_HISTORY_LIMIT,
  clampText,
  extractResult,
  sliceAfterCursor,
  summarizeActivity,
  summarizeHistory,
  summarizeTodos,
} from "./subagent-summarize.js"
import {
  formatShortDuration,
  formatTokens,
  renderChildHeader,
  renderChildLines,
  statusGlyph,
  statusRank,
  usedTokens,
} from "./subagent-format.js"

/** Build one assistant message entry with text and/or tool parts. */
function assistant(id, parts) {
  return { info: { id, role: "assistant", time: { created: 1000 } }, parts }
}

test("summarizeActivity reports an in-flight tool call with elapsed time", () => {
  const messages = [
    assistant("a1", [
      { type: "text", text: "Looking at the checkout flow." },
      {
        type: "tool",
        tool: "bash",
        callID: "call1",
        state: { status: "running", time: { start: 5000 } },
      },
    ]),
    {
      info: { id: "a2", role: "assistant", time: { created: 6000 } },
      parts: [
        {
          type: "tool",
          tool: "todowrite",
          callID: "call2",
          state: {
            status: "completed",
            time: { start: 6000, end: 6001 },
            input: {
              todos: [
                { content: "Build checkout UI", status: "in_progress" },
                { content: "Wire API", status: "pending" },
                { content: "Tests", status: "completed" },
              ],
            },
          },
        },
      ],
    },
  ]
  const activity = summarizeActivity(messages, { now: 620000 })
  expect(activity.inFlight).toHaveLength(1)
  expect(activity.inFlight[0]).toMatchObject({ tool: "bash", startedAt: 5000, runningMs: 615000 })
  expect(activity.todos).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1, current: "Build checkout UI" })
  expect(activity.counts).toMatchObject({ messages: 2, assistant: 2, user: 0, toolCalls: 2, toolErrors: 0 })
})

test("summarizeActivity falls back to the newest assistant text when nothing is in flight", () => {
  const messages = [
    assistant("a1", [{ type: "text", text: "first draft" }]),
    assistant("a2", [{ type: "text", text: "second draft" }]),
  ]
  const activity = summarizeActivity(messages, { now: 2000 })
  expect(activity.inFlight).toEqual([])
  expect(activity.lastText).toBe("second draft")
  expect(activity.lastRole).toBe("assistant")
})

test("summarizeActivity counts tool calls once per call id and errors once", () => {
  const messages = [
    assistant("a1", [
      { type: "tool", tool: "read", callID: "x", state: { status: "running", time: { start: 1000 } } },
      { type: "tool", tool: "read", callID: "x", state: { status: "error", time: { start: 1000, end: 1100 } } },
      { type: "tool", tool: "grep", callID: "y", state: { status: "error", time: { start: 1200, end: 1300 } } },
    ]),
  ]
  const activity = summarizeActivity(messages, { now: 1500 })
  expect(activity.counts.toolCalls).toBe(2)
  expect(activity.counts.toolErrors).toBe(2)
  expect(activity.stats.toolCounts).toEqual({ read: 1, grep: 1 })
})

test("summarizeActivity takes the latest assistant tokens and does not sum messages", () => {
  const messages = [
    {
      info: { id: "a1", role: "assistant", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "one" }],
    },
    {
      info: {
        id: "a2",
        role: "assistant",
        tokens: { input: 500, output: 40, reasoning: 5, cache: { read: 10, write: 0 } },
        providerID: "anthropic",
        modelID: "claude",
        model: { limit: { context: 200000 } },
      },
      parts: [{ type: "text", text: "two" }],
    },
  ]
  const activity = summarizeActivity(messages, { now: 9000 })
  expect(activity.stats.tokens).toMatchObject({ input: 500, output: 40, reasoning: 5 })
  expect(activity.stats.model).toEqual({ providerID: "anthropic", modelID: "claude" })
  expect(activity.stats.contextLimit).toBe(200000)
  expect(usedTokens(activity.stats.tokens)).toBe(555)
})

test("summarizeActivity tracks lastActivity and sinceLastActivityMs", () => {
  const messages = [
    assistant("a1", [
      { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", time: { start: 1000, end: 7000 } } },
    ]),
  ]
  const activity = summarizeActivity(messages, { now: 8000 })
  expect(activity.lastActivity).toBe("tool:bash")
  expect(activity.lastActivityAt).toBe(7000)
  expect(activity.sinceLastActivityMs).toBe(1000)
})

test("summarizeHistory renders assistant, tool-call, and tool-result lines", () => {
  const messages = [
    { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "do the thing" }] },
    assistant("a1", [
      { type: "text", text: "working on it" },
      { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "a.ts" }, output: "ok" } },
    ]),
  ]
  const history = summarizeHistory(messages, { limit: 20, maxChars: 4000 })
  expect(history).toContain("[user] do the thing")
  expect(history).toContain("[assistant] working on it")
  expect(history).toContain("→ read")
  expect(history).toContain("← read ok")
})

test("summarizeHistory skips synthetic and ignored parts", () => {
  const messages = [
    assistant("a1", [
      { type: "text", text: "hidden", synthetic: true },
      { type: "text", text: "ignored", ignored: true },
      { type: "text", text: "visible" },
    ]),
  ]
  const history = summarizeHistory(messages)
  expect(history).toContain("visible")
  expect(history).not.toContain("hidden")
  expect(history).not.toContain("ignored")
})

test("summarizeHistory honours limit by keeping the newest messages", () => {
  const messages = Array.from({ length: 30 }, (_, index) => assistant(`a${index}`, [{ type: "text", text: `line ${index}` }]))
  const history = summarizeHistory(messages, { limit: 5 })
  expect(history).not.toContain("line 24")
  expect(history).toContain("line 25")
  expect(history).toContain("line 29")
  // The default limit is 20.
  expect(DEFAULT_HISTORY_LIMIT).toBe(20)
})

test("summarizeHistory honours maxChars and notes omitted lines", () => {
  const messages = Array.from({ length: 20 }, (_, index) => assistant(`a${index}`, [{ type: "text", text: `x${index} `.repeat(50) }]))
  const history = summarizeHistory(messages, { limit: 20, maxChars: 400 })
  expect(history.length).toBeLessThanOrEqual(400 + 60)
  expect(history).toContain("earlier line(s) omitted")
})

test("summarizeTodos returns null for a non-array and counts statuses", () => {
  expect(summarizeTodos(undefined)).toBeNull()
  expect(summarizeTodos([])).toEqual({ total: 0, completed: 0, inProgress: 0, pending: 0, current: undefined })
  expect(summarizeTodos([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }])).toEqual({
    total: 2,
    completed: 1,
    inProgress: 1,
    pending: 0,
    current: "b",
  })
})

test("clampText and sliceAfterCursor keep their contracts", () => {
  expect(clampText("abc", 10)).toBe("abc")
  expect(sliceAfterCursor([{ info: { id: "a" } }, { info: { id: "b" } }], "a")).toEqual([{ info: { id: "b" } }])
  expect(sliceAfterCursor([{ info: { id: "a" } }], "missing")).toHaveLength(1)
})

test("formatting helpers render tokens, durations, and glyphs", () => {
  expect(formatTokens(987)).toBe("987")
  expect(formatTokens(12345)).toBe("12.3k")
  expect(formatTokens(1_240_000)).toBe("1.24M")
  expect(formatShortDuration(252000)).toBe("4m12s")
  expect(formatShortDuration(38_000)).toBe("38s")
  expect(formatShortDuration(3_900_000)).toBe("1h05m")
  expect(statusGlyph("running")).toBe("●")
  expect(statusGlyph("stale")).toBe("◐")
  expect(statusGlyph("done")).toBe("✓")
  expect(statusGlyph("error")).toBe("✕")
  expect(statusGlyph("nonsense")).toBe("?")
  expect(statusRank("running")).toBeLessThan(statusRank("stale"))
  expect(statusRank("done")).toBeLessThan(statusRank("unknown"))
})

test("renderChildHeader aggregates statuses in triage order", () => {
  const header = renderChildHeader([
    { status: "done" },
    { status: "running" },
    { status: "running" },
    { status: "stale" },
  ])
  expect(header).toBe("4 children · 2 running · 1 stale · 1 done")
  expect(renderChildHeader([{ status: "running" }])).toBe("1 child · 1 running")
})

test("renderChildLines renders two lines with identity, cost, and todo", () => {
  const lines = renderChildLines(
    [
      {
        sessionID: "ses_abc123ef",
        title: "Build checkout UI",
        agent: "frontend",
        slug: "hidden-panda",
        status: "running",
        elapsedMs: 252000,
        activeTool: { tool: "bash", runningMs: 130000 },
        todo: { total: 5, completed: 2, inProgress: 1, pending: 2, current: "Build checkout UI" },
        toolCalls: 8,
        toolErrors: 1,
        tokens: { input: 12000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
        contextLimit: 200000,
        contextPercent: 6,
        sinceLastActivityMs: 4000,
      },
    ],
    {},
  )
  expect(lines).toHaveLength(2)
  // Full session id is never shortened.
  expect(lines[0]).toContain("ses_abc123ef")
  expect(lines[0]).toContain("frontend")
  expect(lines[0]).toContain("hidden-panda")
  expect(lines[0]).toContain("4m12s")
  expect(lines[1]).toContain("tool:bash 2m10s")
  expect(lines[1]).toContain("todo 2/5")
  expect(lines[1]).toContain("8 calls (1 err)")
  expect(lines[1]).toContain("12.3k/200k ctx 6%")
  expect(lines[1]).toContain("last activity 4s ago")
})

test("renderChildLines drops segments gracefully when data is missing", () => {
  const lines = renderChildLines([
    { sessionID: "ses_min", status: "unknown" },
  ])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toBe("?  ses_min  unknown")
})

test("renderChildLines adds a hint only for stale and dead rows", () => {
  const stale = renderChildLines([
    {
      sessionID: "ses_s",
      status: "stale",
      sinceLastProgressMs: 724000,
    },
  ])
  expect(stale[0]).toContain("→ subagent_cancel or subagent_result")
  const running = renderChildLines([{ sessionID: "ses_r", status: "running" }])
  expect(running.join("\n")).not.toContain("subagent_cancel")
})

test("renderChildLines omits the context percent when the limit is unknown", () => {
  const lines = renderChildLines([
    {
      sessionID: "ses_t",
      status: "running",
      tokens: { input: 1500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  expect(lines[1]).toContain("1.5k ctx")
  expect(lines[1]).not.toContain("%")
})

test("renderChildLines verbose adds parent, clocks, and per-tool counts", () => {
  const lines = renderChildLines(
    [
      {
        sessionID: "ses_v",
        status: "running",
        parentID: "ses_parent",
        sinceLastProgressMs: 2000,
        sinceLastEventMs: 500,
        toolCounts: { bash: 5, edit: 3 },
      },
    ],
    { verbose: true },
  )
  expect(lines[1]).toContain("parent=ses_parent")
  expect(lines[1]).toContain("sinceProgress=2s")
  expect(lines[1]).toContain("lastEvent=0s")
  expect(lines[1]).toContain("bash×5 edit×3")
})
