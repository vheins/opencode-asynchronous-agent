import { expect, test } from "bun:test"
import { createSubagentControl } from "./subagent-control.js"
import { fakeClient, stubRegistry } from "./subagent-control-fixtures.js"

test("subagent_result returns the final answer and clamps it", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "the answer" }] }],
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.output).toContain("the answer")
  expect(result.metadata).toMatchObject({
    sessionID: "c1",
    finish: "stop",
    error: null,
    status: "unknown",
    streaming: false,
    partial: false,
    nextCursor: "a1",
  })
})

test("subagent_result view auto on a running child returns the activity report", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "so far" }] }],
  })
  const registry = stubRegistry({ status: "running" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata).toMatchObject({ view: "activity", status: "running", streaming: true, partial: true })
  // The former dead end ("may still be running") must not appear.
  expect(result.output).not.toContain("may still be running")
  expect(result.output).toContain("is working")
  expect(result.output).toContain("Latest: so far")
})

test("subagent_result view result keeps the partial marker for a streaming child", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "so far" }] }],
  })
  const registry = stubRegistry({ status: "running" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1", view: "result" })
  expect(result.metadata).toMatchObject({ view: "result", streaming: true, partial: true })
  expect(result.output).toContain("[partial]")
  expect(result.output).toContain("so far")
})

test("subagent_result treats an in-flight tool call as streaming even when stale", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "partial" }] }],
  })
  const registry = stubRegistry({ status: "stale", item: { activeTool: { tool: "bash", runningMs: 1000 } } })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata.streaming).toBe(true)
})

test("subagent_result honors sinceMessageID as a read cursor", async () => {
  const { client } = fakeClient({
    messages: [
      { info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "old" }] },
      { info: { id: "a2", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "new" }] },
    ],
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1", sinceMessageID: "a1" })
  expect(result.output).toContain("new")
  expect(result.output).not.toContain("old")
  expect(result.metadata.nextCursor).toBe("a2")
})

test("subagent_result reports an empty session", async () => {
  const { client } = fakeClient({ messages: [] })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata.found).toBe(false)
  expect(result.output).toContain("No assistant answer")
})

test("subagent_result view auto on a finished child returns the final answer", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "the answer" }] }],
  })
  const registry = stubRegistry({ status: "done" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata).toMatchObject({ view: "result", status: "done", streaming: false })
  expect(result.output).toContain("the answer")
  expect(result.output).not.toContain("is working")
})

test("subagent_result view auto on a done child with no answer says so plainly", async () => {
  const { client } = fakeClient({ messages: [] })
  const registry = stubRegistry({ status: "done" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata).toMatchObject({ view: "result", status: "done" })
  expect(result.output).toContain("No assistant answer found")
  expect(result.output).not.toContain("may still be running")
})

test("subagent_result view history renders a transcript and honours limit", async () => {
  const { client } = fakeClient({
    messages: [
      { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "do it" }] },
      {
        info: { id: "a1", role: "assistant", time: { created: 2 } },
        parts: [
          { type: "text", text: "on it" },
          { type: "tool", tool: "grep", callID: "c1", state: { status: "completed", input: { pattern: "x" }, output: "match" } },
        ],
      },
    ],
  })
  const registry = stubRegistry({ status: "running" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1", view: "history", limit: 5 })
  expect(result.metadata.view).toBe("history")
  expect(result.output).toContain("[user] do it")
  expect(result.output).toContain("[assistant] on it")
  expect(result.output).toContain("→ grep")
  expect(result.output).toContain("← grep ok")
})

test("subagent_result activity metadata carries slug, cost, and counts", async () => {
  const { client } = fakeClient({
    messages: [
      {
        info: {
          id: "a1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude",
          tokens: { input: 500, output: 40, reasoning: 5, cache: { read: 10, write: 0 } },
        },
        parts: [
          { type: "text", text: "working" },
          { type: "tool", tool: "bash", callID: "c1", state: { status: "error", time: { start: 1000, end: 1200 }, error: "fail" } },
        ],
      },
    ],
  })
  const registry = stubRegistry({ status: "running", item: { slug: "quiet-otter", agent: "backend" } })
  const control = createSubagentControl({ client, registry, now: () => 10_000 })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1", view: "activity" })
  expect(result.metadata).toMatchObject({
    sessionID: "c1",
    slug: "quiet-otter",
    status: "running",
    toolCalls: 1,
    toolErrors: 1,
    contextUsed: 555,
    model: { providerID: "anthropic", modelID: "claude" },
  })
  // No limit was reported, so the percent stays null rather than fabricated.
  expect(result.metadata.contextPercent).toBeNull()
})

test("subagent_result activity uses registry liveness when the message list is empty", async () => {
  // Regression: the registry knows a bash call is in flight while `messages`
  // returns nothing. The rendered text used to say "no tool call in flight"
  // right next to metadata claiming activeTool=bash — two contradicting answers
  // in one response.
  const { client } = fakeClient({ messages: [] })
  const registry = stubRegistry({
    status: "running",
    item: {
      activity: "tool",
      activeTool: { tool: "bash", runningMs: 300000 },
      sinceLastProgressMs: 300000,
      todo: { total: 3, completed: 1, inProgress: 1, pending: 1, current: "Wire the payment form" },
    },
  })
  const control = createSubagentControl({ client, registry, now: () => 10_000 })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata).toMatchObject({
    view: "activity",
    activity: "tool",
    activeTool: { tool: "bash", runningMs: 300000 },
    inFlight: 1,
  })
  expect(result.output).toContain("In flight: bash for 5m 0s")
  expect(result.output).not.toContain("No tool call in flight")
  // Todo progress survives too, so the activity report is complete.
  expect(result.output).toContain("Todos: 1/3 done")
})


test("subagent_result view auto treats a dead child as terminal and points at recovery", async () => {
  // Regression: `dead` was counted as live, so `auto` returned an activity
  // report and hid the death behind a "working" narrative.
  const { client } = fakeClient({ messages: [] })
  const registry = stubRegistry({ status: "dead" })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata).toMatchObject({ view: "result", status: "dead" })
  expect(result.output).toContain("appears dead")
  expect(result.output).toContain("subagent_cancel")
  expect(result.output).not.toContain("is working")
})
