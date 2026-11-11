import { expect, test } from "bun:test"
import { createSubagentControl } from "./subagent-control.js"
import { fakeClient, regItem, stubRegistry } from "./subagent-control-fixtures.js"

test("subagent_children lists child sessions with status", async () => {
  const { client } = fakeClient({
    children: [
      { id: "c1", title: "Child", parentID: "p1", directory: "/x", time: { updated: 5 } },
    ],
    status: { c1: { type: "busy" } },
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.metadata.children).toMatchObject([
    {
      sessionID: "c1",
      title: "Child",
      parentID: "p1",
      directory: "/x",
      status: "running",
      sdkStatus: "busy",
      source: "sdk",
      stale: false,
      dead: false,
      activity: null,
      activeTool: null,
      updated: 5,
    },
  ])
  // The plugin lifecycle vocabulary, never the raw SDK type.
  expect(result.output).toContain("running")
  expect(result.output).not.toContain("busy")
  expect(result.output).toContain("c1")
  expect(result.metadata.counts).toEqual({ total: 1, running: 1 })
})

test("subagent_children prefers the registry's classified status over the SDK", async () => {
  const { client } = fakeClient({
    children: [{ id: "c1", title: "Child", parentID: "p1", time: { updated: 5 } }],
    // SDK says nothing about c1 (previously this would have been reported idle).
    status: {},
  })
  const registry = stubRegistry({ status: "stale", item: { sinceLastProgressMs: 300000, agent: "backend" } })
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.metadata.children[0]).toMatchObject({
    sessionID: "c1",
    status: "stale",
    source: "registry",
    stale: true,
    agent: "backend",
    sinceLastProgressMs: 300000,
  })
})

test("subagent_children reports unknown rather than idle when nothing knows the child", async () => {
  const { client } = fakeClient({
    children: [{ id: "c1", title: "Child", parentID: "p1" }],
    status: {},
  })
  const control = createSubagentControl({ client })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.metadata.children[0]).toMatchObject({ status: "unknown", source: "unknown" })
})

test("subagent_children degrades when the SDK method is missing", async () => {
  const control = createSubagentControl({ client: { session: {} } })
  const result = await control.tool.subagent_children.execute({ sessionID: "p1" })
  expect(result.output).toContain("unavailable")
})

test("subagent_children sorts live work first and prints an aggregate header", async () => {
  const registry = stubRegistry({
    items: [
      regItem({ sessionID: "ses_done", status: "done", startedAt: 1000, elapsedMs: 63000 }),
      regItem({ sessionID: "ses_run_late", status: "running", startedAt: 9000, elapsedMs: 4000 }),
      regItem({ sessionID: "ses_stale", status: "stale", startedAt: 2000, elapsedMs: 724000 }),
      regItem({ sessionID: "ses_run_early", status: "running", startedAt: 3000, elapsedMs: 12000 }),
    ],
  })
  const control = createSubagentControl({ client: fakeClient().client, registry })
  const result = await control.tool.subagent_children.execute({})
  expect(result.output.startsWith("4 children · 2 running · 1 stale · 1 done")).toBe(true)
  const order = result.metadata.children.map((row) => row.sessionID)
  // running (startedAt asc) → stale → done
  expect(order).toEqual(["ses_run_early", "ses_run_late", "ses_stale", "ses_done"])
  expect(result.metadata.counts).toEqual({ total: 4, running: 2, stale: 1, done: 1 })
  expect(result.metadata.truncated).toBe(false)
})

test("subagent_children filters by status", async () => {
  const registry = stubRegistry({
    items: [regItem({ sessionID: "a", status: "running" }), regItem({ sessionID: "b", status: "done" })],
  })
  const control = createSubagentControl({ client: fakeClient().client, registry })
  const result = await control.tool.subagent_children.execute({ status: "done" })
  expect(result.metadata.children.map((row) => row.sessionID)).toEqual(["b"])
  // Counts describe the filtered set.
  expect(result.metadata.counts).toEqual({ total: 1, done: 1 })
})

test("subagent_children applies limit and notes the truncation", async () => {
  const items = Array.from({ length: 5 }, (_, index) => regItem({ sessionID: `ses_${index}`, startedAt: 1000 + index }))
  const registry = stubRegistry({ items })
  const control = createSubagentControl({ client: fakeClient().client, registry })
  const result = await control.tool.subagent_children.execute({ limit: 2 })
  expect(result.metadata.children).toHaveLength(2)
  expect(result.metadata.truncated).toBe(true)
  // The aggregate still describes every matching child.
  expect(result.metadata.counts.total).toBe(5)
  expect(result.output).toContain("… +3 more (limit=2)")
})

test("subagent_children falls back to the registry when sessionID is omitted", async () => {
  const registry = stubRegistry({
    items: [regItem({ sessionID: "ses_a" }), regItem({ sessionID: "ses_b", status: "done" })],
  })
  const { client, calls } = fakeClient()
  const control = createSubagentControl({ client, registry })
  const result = await control.tool.subagent_children.execute({})
  expect(calls.children).toHaveLength(0)
  expect(result.metadata.children).toHaveLength(2)
  expect(result.metadata.children[0].source).toBe("registry")
})

test("subagent_children explains itself when neither sessionID nor a registry exists", async () => {
  const control = createSubagentControl({ client: fakeClient().client })
  const result = await control.tool.subagent_children.execute({})
  expect(result.output).toContain("sessionID")
  expect(result.output).toContain("OPENCODE_SUBAGENT_STATUS")
})

test("subagent_children never shortens a session id and omits absent identity", async () => {
  const long = "ses_01JABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const registry = stubRegistry({ items: [regItem({ sessionID: long, agent: undefined, slug: undefined, title: undefined })] })
  const control = createSubagentControl({ client: fakeClient().client, registry })
  const result = await control.tool.subagent_children.execute({})
  expect(result.output).toContain(long)
  // Absent identity is omitted, never faked with a placeholder.
  expect(result.metadata.children[0].agent).toBeUndefined()
  expect(result.metadata.children[0].slug).toBeUndefined()
  expect(result.output).not.toContain("Untitled")
})

test("subagent_children metadata carries the full programmatic surface", async () => {
  const registry = stubRegistry({
    items: [
      regItem({
        sessionID: "ses_meta",
        title: "Backend",
        agent: "backend",
        slug: "quiet-otter",
        toolCalls: 8,
        toolErrors: 1,
        toolCounts: { bash: 5, edit: 3 },
        tokens: { input: 12000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
        contextLimit: 200000,
        contextUsed: 12300,
        contextPercent: 6,
        todo: { total: 5, completed: 2, inProgress: 1, pending: 2, current: "Wire API" },
        lastActivity: "tool:bash",
        lastActivityAt: 5000,
        sinceLastActivityMs: 4000,
        model: { providerID: "anthropic", modelID: "claude" },
        startedAt: 1000,
      }),
    ],
  })
  const control = createSubagentControl({ client: fakeClient().client, registry })
  const result = await control.tool.subagent_children.execute({})
  expect(result.metadata.children[0]).toMatchObject({
    sessionID: "ses_meta",
    parentID: "ses_parent",
    status: "running",
    agent: "backend",
    activity: "idle",
    activeTool: null,
    todo: { total: 5, completed: 2, current: "Wire API" },
    elapsedMs: 60000,
    sinceLastProgressMs: 0,
    stale: false,
    dead: false,
    source: "registry",
    slug: "quiet-otter",
    toolCalls: 8,
    toolErrors: 1,
    toolCounts: { bash: 5, edit: 3 },
    contextLimit: 200000,
    contextUsed: 12300,
    contextPercent: 6,
    lastActivity: "tool:bash",
    lastActivityAt: 5000,
    sinceLastActivityMs: 4000,
    model: { providerID: "anthropic", modelID: "claude" },
  })
  expect(result.metadata.counts).toEqual({ total: 1, running: 1 })
})

