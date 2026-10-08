import { expect, test } from "bun:test"
import {
  clampText,
  controlEnabled,
  createSubagentControl,
  extractResult,
  isActiveStatus,
  pickStatus,
  resolveTarget,
  unwrap,
} from "./subagent-control.js"

/** Fake SDK client capturing calls and returning canned payloads. */
function fakeClient(overrides = {}) {
  const calls = { children: [], messages: [], status: 0, abort: [], promptAsync: [], get: [] }
  const client = {
    session: {
      get: async (input) => {
        calls.get.push(input)
        return { data: overrides.get }
      },
      children: async (input) => {
        calls.children.push(input)
        return { data: overrides.children ?? [] }
      },
      messages: async (input) => {
        calls.messages.push(input)
        return { data: overrides.messages ?? [] }
      },
      status: async () => {
        calls.status += 1
        return { data: overrides.status ?? {} }
      },
      abort: async (input) => {
        calls.abort.push(input)
        return { data: overrides.abort ?? true }
      },
      promptAsync: async (input) => {
        calls.promptAsync.push(input)
        return { data: undefined }
      },
    },
  }
  return { client, calls }
}

test("unwrap tolerates both { data } and bare payloads", () => {
  expect(unwrap({ data: [1, 2] })).toEqual([1, 2])
  expect(unwrap([1, 2])).toEqual([1, 2])
  expect(unwrap(undefined)).toBeUndefined()
  expect(unwrap({ ok: true })).toEqual({ ok: true })
})

test("isActiveStatus treats busy/retry as active and idle/undefined as not", () => {
  expect(isActiveStatus({ type: "busy" })).toBe(true)
  expect(isActiveStatus({ type: "retry" })).toBe(true)
  expect(isActiveStatus({ type: "idle" })).toBe(false)
  expect(isActiveStatus(undefined)).toBe(false)
})

test("pickStatus defaults to idle for an unknown session", () => {
  expect(pickStatus({ a: { type: "busy" } }, "a")).toEqual({ type: "busy" })
  expect(pickStatus({ a: { type: "busy" } }, "b")).toEqual({ type: "idle" })
  expect(pickStatus(undefined, "a")).toEqual({ type: "idle" })
})

test("clampText leaves short text and truncates long text with a marker", () => {
  expect(clampText("hello", 10)).toBe("hello")
  const long = "x".repeat(100)
  const clamped = clampText(long, 40)
  expect(clamped.length).toBeLessThanOrEqual(40)
  expect(clamped).toContain("truncated")
  expect(clampText("hello", 0)).toBe("hello")
  // A cap smaller than the marker degrades to a plain slice, never overshoots.
  expect(clampText(long, 5).length).toBeLessThanOrEqual(5)
})

test("extractResult returns the last assistant non-synthetic text and terminal info", () => {
  const messages = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "question" }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "draft" }] },
    {
      info: { id: "a2", role: "assistant", finish: "stop", error: { name: "X" } },
      parts: [
        { type: "text", text: "synthetic", synthetic: true },
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "final answer" },
      ],
    },
  ]
  expect(extractResult(messages)).toEqual({
    text: "final answer",
    error: { name: "X" },
    finish: "stop",
    messageID: "a2",
    found: true,
  })
})

test("extractResult reports empty when there is no assistant text", () => {
  expect(extractResult([])).toMatchObject({ text: "", found: false, messageID: undefined })
  expect(
    extractResult([{ info: { id: "a1", role: "assistant" }, parts: [{ type: "reasoning", text: "x" }] }]),
  ).toMatchObject({ text: "", found: false })
})

test("controlEnabled honors OPENCODE_SUBAGENT_CONTROL and OPENCODE_SUBAGENT_STATUS", () => {
  const saved = { c: process.env.OPENCODE_SUBAGENT_CONTROL, s: process.env.OPENCODE_SUBAGENT_STATUS }
  try {
    delete process.env.OPENCODE_SUBAGENT_CONTROL
    delete process.env.OPENCODE_SUBAGENT_STATUS
    expect(controlEnabled()).toBe(false)
    process.env.OPENCODE_SUBAGENT_CONTROL = "1"
    expect(controlEnabled()).toBe(true)
    delete process.env.OPENCODE_SUBAGENT_CONTROL
    process.env.OPENCODE_SUBAGENT_STATUS = "yes"
    expect(controlEnabled()).toBe(true)
  } finally {
    if (saved.c === undefined) delete process.env.OPENCODE_SUBAGENT_CONTROL
    else process.env.OPENCODE_SUBAGENT_CONTROL = saved.c
    if (saved.s === undefined) delete process.env.OPENCODE_SUBAGENT_STATUS
    else process.env.OPENCODE_SUBAGENT_STATUS = saved.s
  }
})

test("subagent_children lists child sessions with status", async () => {
  const { client } = fakeClient({
    children: [
      { id: "c1", title: "Child", parentID: "p1", directory: "/x", time: { updated: 5 } },
    ],
    status: { c1: { type: "busy" } },
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.metadata.children).toEqual([
    { sessionID: "c1", title: "Child", parentID: "p1", directory: "/x", status: "busy", updated: 5 },
  ])
  expect(result.output).toContain("c1")
})

test("subagent_children degrades when the SDK method is missing", async () => {
  const control = createSubagentControl({ client: { session: {} } })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.output).toContain("unavailable")
})

test("subagent_result returns the final answer and clamps it", async () => {
  const { client } = fakeClient({
    messages: [{ info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "the answer" }] }],
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.output).toContain("the answer")
  expect(result.metadata).toMatchObject({ sessionID: "c1", finish: "stop", error: null })
})

test("subagent_result reports an empty session", async () => {
  const { client } = fakeClient({ messages: [] })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_result.execute({ sessionID: "c1" })
  expect(result.metadata.found).toBe(false)
  expect(result.output).toContain("No assistant answer")
})

test("subagent_wait returns immediately when nothing is active", async () => {
  let clock = 0
  const { client, calls } = fakeClient({ status: {} })
  const control = createSubagentControl({ client, now: () => clock, sleep: async () => {} })
  const result = await control.tool.subagent_wait.execute({ sessionIDs: ["c1", "c2"], timeoutMs: 5000 })
  expect(result.metadata.timedOut).toBe(false)
  expect(result.metadata.pending).toEqual([])
  expect(calls.status).toBe(1)
})

test("subagent_wait polls until active sessions finish", async () => {
  let clock = 0
  const statuses = [{ c1: { type: "busy" } }, { c1: { type: "busy" } }, {}]
  let index = 0
  const client = {
    session: {
      status: async () => ({ data: statuses[Math.min(index++, statuses.length - 1)] }),
    },
  }
  const control = createSubagentControl({
    client,
    now: () => (clock += 100),
    sleep: async () => {},
    pollMs: 100,
  })
  const result = await control.tool.subagent_wait.execute({ sessionIDs: ["c1"], timeoutMs: 10000 })
  expect(result.metadata.timedOut).toBe(false)
  expect(result.metadata.sessions).toEqual([{ sessionID: "c1", status: "idle" }])
})

test("subagent_wait times out on a still-active session", async () => {
  let clock = 0
  const { client } = fakeClient({ status: { c1: { type: "busy" } } })
  const control = createSubagentControl({
    client,
    now: () => (clock += 1000),
    sleep: async () => {},
    pollMs: 100,
  })
  const result = await control.tool.subagent_wait.execute({ sessionIDs: ["c1"], timeoutMs: 2000 })
  expect(result.metadata.timedOut).toBe(true)
  expect(result.metadata.pending).toEqual(["c1"])
  expect(result.output).toContain("Timed out")
})

test("subagent_wait with no ids is a no-op", async () => {
  const { client } = fakeClient()
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_wait.execute({ sessionIDs: [] })
  expect(result.output).toContain("No session ids")
})

test("subagent_wait stops early when the parent aborts", async () => {
  let clock = 0
  const { client } = fakeClient({ status: { c1: { type: "busy" } } })
  const control = createSubagentControl({
    client,
    now: () => (clock += 100),
    sleep: async () => {},
    pollMs: 100,
  })
  const result = await control.tool.subagent_wait.execute(
    { sessionIDs: ["c1"], timeoutMs: 600000 },
    { abort: { aborted: true } },
  )
  expect(result.metadata.aborted).toBe(true)
  expect(result.metadata.timedOut).toBe(true)
  expect(result.output).toContain("cancelled")
})

test("subagent_cancel aborts and reports acceptance", async () => {
  const { client, calls } = fakeClient({ abort: true })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_cancel.execute({ sessionID: "c1" })
  expect(calls.abort).toEqual([{ path: { id: "c1" } }])
  expect(result.metadata.accepted).toBe(true)
})

test("subagent_send queues text via promptAsync", async () => {
  const { client, calls } = fakeClient()
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "extra context" })
  expect(calls.promptAsync).toEqual([
    { path: { id: "c1" }, body: { parts: [{ type: "text", text: "extra context" }] } },
  ])
  expect(result.output).toContain("Queued")
})

test("subagent_send rejects an empty prompt", async () => {
  const { client, calls } = fakeClient()
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "" })
  expect(calls.promptAsync).toHaveLength(0)
  expect(result.output).toContain("No prompt text")
})

test("subagent_send preserves the child's agent and model", async () => {
  const { client, calls } = fakeClient({
    get: { id: "c1", agent: "Frontend", model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "default" } },
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "continue" })
  expect(calls.get).toEqual([{ path: { id: "c1" } }])
  expect(calls.promptAsync).toEqual([
    {
      path: { id: "c1" },
      body: {
        parts: [{ type: "text", text: "continue" }],
        agent: "Frontend",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      },
    },
  ])
  expect(result.output).toContain("as Frontend")
})

test("subagent_send preserves a non-default model variant", async () => {
  const { client, calls } = fakeClient({
    get: { id: "c1", agent: "Frontend", model: { id: "gpt-5", providerID: "openai", variant: "high" } },
  })
  const control = createSubagentControl({ client })
  await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "continue" })
  expect(calls.promptAsync[0].body).toEqual({
    parts: [{ type: "text", text: "continue" }],
    agent: "Frontend",
    model: { providerID: "openai", modelID: "gpt-5" },
    variant: "high",
  })
})

test("subagent_send still works when the child lookup fails", async () => {
  const { client, calls } = fakeClient()
  client.session.get = async () => {
    throw new Error("nope")
  }
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "hi" })
  expect(calls.promptAsync).toEqual([
    { path: { id: "c1" }, body: { parts: [{ type: "text", text: "hi" }] } },
  ])
  expect(result.output).toContain("Queued")
})

test("resolveTarget reads agent and both model shapes", () => {
  expect(resolveTarget({ agent: "Frontend", model: { id: "m", providerID: "p" } })).toEqual({
    agent: "Frontend",
    model: { providerID: "p", modelID: "m" },
  })
  expect(resolveTarget({ model: { modelID: "m2", providerID: "p2" } })).toEqual({
    model: { providerID: "p2", modelID: "m2" },
  })
  expect(resolveTarget({ model: { id: "m3", providerID: "p3", variant: "high" } })).toEqual({
    model: { providerID: "p3", modelID: "m3" },
    variant: "high",
  })
  expect(resolveTarget({ model: { id: "m4", providerID: "p4", variant: "default" } })).toEqual({
    model: { providerID: "p4", modelID: "m4" },
  })
  expect(resolveTarget({})).toEqual({})
  expect(resolveTarget(undefined)).toEqual({})
  expect(resolveTarget({ agent: "", model: null })).toEqual({})
})

test("all five tools are registered", () => {
  const control = createSubagentControl({ client: fakeClient().client })
  expect(Object.keys(control.tool).sort()).toEqual([
    "subagent_cancel",
    "subagent_children",
    "subagent_result",
    "subagent_send",
    "subagent_wait",
  ])
})
