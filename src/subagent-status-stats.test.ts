import { expect, test } from "bun:test"
import { createSubagentStatus } from "./subagent-status.js"

/** Assert a lookup produced a value, narrowing the type for the rest of the test. */
function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value")
  return value
}

test("stats accumulate tool calls from parts without double counting a state change", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  const part = (status: string, extra: object = {}) => ({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "s", type: "tool", tool: "bash", callID: "call1", state: { status, time: { start: 1000, ...extra } } },
    },
  })
  clock = 1010
  feature.registry.ingest(part("running"))
  clock = 1020
  feature.registry.ingest(part("completed", { end: 1020 }))
  clock = 1030
  feature.registry.ingest(part("completed", { end: 1030 }))

  const item = req(feature.registry.get("s"))
  expect(item.toolCalls).toBe(1)
  expect(item.toolCounts).toEqual({ bash: 1 })
  expect(item.toolErrors).toBe(0)
  expect(item.lastTool).toMatchObject({ tool: "bash", status: "completed" })
  expect(item.lastActivity).toBe("tool:bash")
  expect(item.lastActivityAt).toBe(1030)
  expect(item.sinceLastActivityMs).toBe(0)
})

test("stats count a tool error exactly once per call id", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  for (const [tick, status] of [[1010, "running"], [1020, "error"], [1030, "error"]] as const) {
    clock = tick
    feature.registry.ingest({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "s", type: "tool", tool: "read", callID: "c9", state: { status, time: { start: 1000, end: tick } } },
      },
    })
  }
  const item = req(feature.registry.get("s"))
  expect(item.toolCalls).toBe(1)
  expect(item.toolErrors).toBe(1)
})

test("stats take the latest assistant tokens and never sum across messages", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  clock = 1100
  feature.registry.ingest({
    type: "message.updated",
    properties: { info: { sessionID: "s", role: "assistant", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } },
  })
  clock = 1200
  feature.registry.ingest({
    type: "message.updated",
    properties: {
      info: {
        sessionID: "s",
        role: "assistant",
        agent: "backend",
        providerID: "anthropic",
        modelID: "claude",
        tokens: { input: 500, output: 40, reasoning: 5, cache: { read: 10, write: 0 } },
        model: { limit: { context: 200000 } },
      },
    },
  })

  const item = req(feature.registry.get("s"))
  expect(item.tokens).toEqual({ input: 500, output: 40, reasoning: 5, cache: { read: 10, write: 0 } })
  expect(item.contextUsed).toBe(555)
  expect(item.contextLimit).toBe(200000)
  expect(item.contextPercent).toBe(0)
  expect(item.model).toEqual({ providerID: "anthropic", modelID: "claude" })
  expect(item.agent).toBe("backend")
  expect(item.lastActivity).toBe("streaming")
})

test("contextPercent is null when no limit is known and computed when it is", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  feature.registry.ingest({
    type: "message.updated",
    properties: { info: { sessionID: "s", role: "assistant", tokens: { input: 2500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
  })
  expect(req(feature.registry.get("s")).contextPercent).toBeNull()
  expect(req(feature.registry.get("s")).contextUsed).toBe(2500)

  feature.registry.ingest({
    type: "message.updated",
    properties: {
      info: {
        sessionID: "s",
        role: "assistant",
        tokens: { input: 25000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        model: { limit: { context: 200000 } },
      },
    },
  })
  expect(req(feature.registry.get("s")).contextPercent).toBe(13)
})

test("todo.updated caches todo progress with the current in-progress item", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  clock = 1500
  feature.registry.ingest({
    type: "todo.updated",
    properties: {
      sessionID: "s",
      todos: [
        { content: "Wire API", status: "in_progress" },
        { content: "Tests", status: "pending" },
        { content: "Setup", status: "completed" },
      ],
    },
  })
  const item = req(feature.registry.get("s"))
  expect(item.todo).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1, current: "Wire API" })
  expect(item.lastActivity).toBe("todo")
  expect(item.lastActivityAt).toBe(1500)
})

test("lastActivity and sinceLastActivityMs follow the newest event kind", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", time: { created: 1000 } } },
  })
  clock = 2000
  feature.registry.ingest({
    type: "message.updated",
    properties: { info: { sessionID: "s", role: "assistant" } },
  })
  expect(req(feature.registry.get("s")).lastActivity).toBe("streaming")
  clock = 3000
  feature.registry.ingest({
    type: "message.part.updated",
    properties: { part: { sessionID: "s", type: "tool", tool: "grep", callID: "z", state: { status: "running", time: { start: 3000 } } } },
  })
  const item = req(feature.registry.get("s"))
  expect(item.lastActivity).toBe("tool:grep")
  expect(item.lastActivityAt).toBe(3000)
  expect(item.sinceLastActivityMs).toBe(0)
})

test("identity captures slug and agent from session and message events", () => {
  const feature = createSubagentStatus({ now: () => 1000, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", title: "S", slug: "hidden-panda", time: { created: 1000 } } },
  })
  feature.registry.ingest({
    type: "message.updated",
    properties: { info: { sessionID: "s", role: "assistant", agent: "frontend" } },
  })
  const item = req(feature.registry.get("s"))
  expect(item.slug).toBe("hidden-panda")
  expect(item.agent).toBe("frontend")
  expect(item.title).toBe("S")
})

test("identity is omitted, never faked, when the events carry none", () => {
  const feature = createSubagentStatus({ now: () => 1000, threshold: () => 100000, deadThreshold: () => 0 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "s", parentID: "p", time: { created: 1000 } } },
  })
  const item = req(feature.registry.get("s"))
  expect(item.slug).toBeUndefined()
  expect(item.agent).toBeUndefined()
})
