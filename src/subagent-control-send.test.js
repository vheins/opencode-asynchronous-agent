import { expect, test } from "bun:test"
import { createSubagentControl } from "./subagent-control.js"
import { fakeClient, stubRegistry } from "./subagent-control-fixtures.js"

test("subagent_cancel aborts and reports acceptance", async () => {
  const { client, calls } = fakeClient({ abort: true })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_cancel.execute({ sessionID: "c1" })
  expect(calls.abort).toEqual([{ path: { id: "c1" } }])
  expect(result.metadata.accepted).toBe(true)
})

test("subagent_cancel treats a void return as accepted", async () => {
  const { client } = fakeClient() // abort returns { data: undefined }
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_cancel.execute({ sessionID: "c1" })
  expect(result.metadata.accepted).toBe(true)
  expect(result.output).toContain("Abort requested")
})

test("subagent_cancel reports an explicit false as not accepted", async () => {
  const { client } = fakeClient({ abort: false })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_cancel.execute({ sessionID: "c1" })
  expect(result.metadata.accepted).toBe(false)
  expect(result.output).toContain("No running session")
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

test("subagent_send refuses a dead child and does not arm the notice", async () => {
  const { client, calls } = fakeClient()
  const registry = stubRegistry({ status: "dead" })
  const armed = []
  const control = createSubagentControl({ client, registry, onSend: (p, c) => armed.push([p, c]) })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "hi" })
  expect(calls.promptAsync).toHaveLength(0)
  expect(armed).toHaveLength(0)
  expect(result.metadata).toMatchObject({ refused: true, status: "dead" })
  expect(result.output).toContain("dead")
  expect(result.output).toContain("subagent_cancel")
})

test("subagent_send refuses stale/done/error too", async () => {
  for (const status of ["stale", "done", "error"]) {
    const { client, calls } = fakeClient()
    const control = createSubagentControl({ client, registry: stubRegistry({ status }) })
    const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "hi" })
    expect(calls.promptAsync).toHaveLength(0)
    expect(result.metadata.refused).toBe(true)
  }
})

test("subagent_send force bypasses the liveness guard", async () => {
  const { client, calls } = fakeClient()
  const control = createSubagentControl({ client, registry: stubRegistry({ status: "dead" }) })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "hi", force: true })
  expect(calls.promptAsync).toHaveLength(1)
  expect(result.output).toContain("Queued")
})

test("subagent_send allows a running child", async () => {
  const { client, calls } = fakeClient()
  const control = createSubagentControl({ client, registry: stubRegistry({ status: "running" }) })
  const result = await control.tool.subagent_send.execute({ sessionID: "c1", prompt: "hi" })
  expect(calls.promptAsync).toHaveLength(1)
  expect(result.output).toContain("Queued")
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

