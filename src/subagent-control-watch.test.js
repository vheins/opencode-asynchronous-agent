import { expect, test } from "bun:test"
import { createSubagentControl } from "./subagent-control.js"
import { createSubagentStatus } from "./subagent-status.js"
import { fakeClient, stubRegistry, watchHarness } from "./subagent-control-fixtures.js"

test("subagent_watch returns immediately when the status changes", async () => {
  const registry = stubRegistry({ status: "running" })
  const { now, sleep } = watchHarness(registry, { statuses: ["running", "done"] })
  const control = createSubagentControl({ client: fakeClient().client, registry, now, sleep })
  const result = await control.tool.subagent_watch.execute({ sessionID: "c1", timeoutMs: 15000 })
  expect(result.metadata).toMatchObject({ changed: true, status: "done", timedOut: false })
  expect(result.metadata.elapsedMs).toBeLessThanOrEqual(15000)
})

test("subagent_watch reports an activity change as a change", async () => {
  const registry = stubRegistry({ status: "running", item: { activity: "tool" } })
  let clock = 0
  let ticks = 0
  const now = () => clock
  const sleep = async (ms) => {
    clock += ms
    ticks += 1
    // The tool finishes and the child goes quiet: status stays running but
    // activity flips from tool -> idle.
    if (ticks === 2) registry.state.item = { activity: "idle" }
  }
  const control = createSubagentControl({ client: fakeClient().client, registry, now, sleep })
  const result = await control.tool.subagent_watch.execute({ sessionID: "c1", timeoutMs: 15000 })
  expect(result.metadata).toMatchObject({ changed: true, status: "running", activity: "idle" })
})

test("subagent_watch times out at the cap", async () => {
  const registry = stubRegistry({ status: "running" })
  const { now, sleep } = watchHarness(registry, { statuses: [] })
  const control = createSubagentControl({ client: fakeClient().client, registry, now, sleep, watchMaxMs: 5000 })
  const result = await control.tool.subagent_watch.execute({ sessionID: "c1", timeoutMs: 60000 })
  expect(result.metadata).toMatchObject({ changed: false, timedOut: true, status: "running" })
  expect(result.metadata.elapsedMs).toBeLessThanOrEqual(5000)
  expect(result.metadata.elapsedMs).toBeGreaterThanOrEqual(5000)
})

test("subagent_watch never queries the SDK", async () => {
  const { client, calls } = fakeClient()
  const registry = stubRegistry({ status: "done" })
  const control = createSubagentControl({
    client,
    registry,
    now: () => 0,
    sleep: async () => {},
    watchMaxMs: 200,
  })
  await control.tool.subagent_watch.execute({ sessionID: "c1", timeoutMs: 100 })
  expect(calls.status).toBe(0)
  expect(calls.children).toHaveLength(0)
  expect(calls.messages).toHaveLength(0)
})

test("registry integration: a real registry drives children and watch", async () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "c1", parentID: "p1", title: "Child", time: { created: 1000 } } },
  })
  const { client } = fakeClient({ children: [{ id: "c1", title: "Child", parentID: "p1" }], status: {} })
  const control = createSubagentControl({ client, registry: feature.registry })
  const children = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(children.metadata.children[0]).toMatchObject({ status: "running", source: "registry" })
})

