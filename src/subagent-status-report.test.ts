import { expect, test } from "bun:test"
import { createSubagentStatus } from "./subagent-status.js"

/** Assert a lookup produced a value, narrowing the type for the rest of the test. */
function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value")
  return value
}

test("reconciliation never stamps now() on pre-existing sessions", async () => {
  let clock = 1_000_000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    client: {
      session: {
        list: async () => ({
          data: [{ id: "old", parentID: "p", title: "Old", time: { created: 500_000, updated: 600_000 } }],
        }),
      },
    },
  })
  await feature.registry.reconcile()
  const item = req(feature.registry.get("old"))
  expect(item.lastProgressAt).toBe(600_000)
  expect(item.sinceLastProgressMs).toBe(400_000)
  expect(item.status).toBe("dead")
})

test("reconciliation treats SDK busy as proof of life and idle as done", async () => {
  let clock = 1000
  const statusMap = { busyChild: { type: "busy" }, idleChild: { type: "idle" } }
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    client: { session: { status: async () => ({ data: statusMap }) } },
  })
  const { ingest, get, reconcile } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "busyChild", parentID: "p", title: "B" } } })
  ingest({ type: "session.created", properties: { info: { id: "idleChild", parentID: "p", title: "I" } } })

  clock = 9000
  await reconcile()
  expect(req(get("busyChild"))).toMatchObject({ status: "running", lastProgressAt: 9000, lastStatusType: "busy" })
  expect(req(get("idleChild"))).toMatchObject({ status: "done", lastStatusType: "idle" })
})

test("reconciliation leaves an absent stale child in the derived dead tier, never done", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    client: { session: { status: async () => ({ data: {} }) } },
  })
  const { ingest, get, reconcile } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "zombie", parentID: "p", title: "Z" } } })

  clock = 3000
  expect(req(get("zombie")).status).toBe("stale")
  await reconcile()
  // Absence is NOT success: the lifecycle stays running and the derived tier
  // keeps speaking, so the `dead` remediation stays reachable.
  expect(req(get("zombie"))).toMatchObject({ status: "stale" })
  expect(req(get("zombie")).doneAt).toBeUndefined()
})

test("done is not inferred from absence alone, and the dead tier survives repeated reports", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    reconcileIntervalMs: 0,
    client: { session: { status: async () => ({ data: {} }) } },
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "wedged", parentID: "p", title: "W" } } })

  clock = 20000
  const first = await feature.tool.subagent_status.execute({})
  expect(req(get("wedged")).status).toBe("dead")
  expect(first.metadata.counts.dead).toBe(1)

  // Reporting again must still show dead: the old bug rewrote it to done on the
  // first report, making the dead tier unobservable.
  const second = await feature.tool.subagent_status.execute({})
  expect(req(get("wedged")).status).toBe("dead")
  expect(second.metadata.counts.dead).toBe(1)
})

test("a positive idle signal still materializes done", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    client: { session: { status: async () => ({ data: { idleChild: { type: "idle" } } }) } },
  })
  const { ingest, get, reconcile } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "idleChild", parentID: "p", title: "I" } } })
  clock = 5000
  await reconcile()
  expect(req(get("idleChild"))).toMatchObject({ status: "done", lastStatusType: "idle" })
})

test("a derived-dead child with a recorded final answer is confirmed done once", async () => {
  let clock = 1000
  let messageCalls = 0
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    reconcileIntervalMs: 0,
    client: {
      session: {
        status: async () => ({ data: {} }),
        messages: async () => {
          messageCalls += 1
          return {
            data: [
              { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "go" }] },
              { info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done it" }] },
            ],
          }
        },
      },
    },
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "kid", parentID: "p", title: "K" } } })

  clock = 20000
  await feature.tool.subagent_status.execute({})
  expect(req(get("kid")).status).toBe("done")
  expect(messageCalls).toBe(1)

  // Cached: further reports never probe the transcript again.
  await feature.tool.subagent_status.execute({})
  await feature.tool.subagent_status.execute({})
  expect(messageCalls).toBe(1)
})

test("a derived-dead child whose last assistant message carries an error is confirmed error", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    reconcileIntervalMs: 0,
    client: {
      session: {
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [{ info: { id: "a1", role: "assistant", error: { name: "boom" } }, parts: [] }] }),
      },
    },
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "kid", parentID: "p", title: "K" } } })
  clock = 20000
  await feature.tool.subagent_status.execute({})
  expect(req(get("kid")).status).toBe("error")
})

test("an unavailable or rejecting session.messages leaves the child derived-dead", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    reconcileIntervalMs: 0,
    client: { session: { status: async () => ({ data: {} }), messages: async () => { throw new Error("nope") } } },
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "kid", parentID: "p", title: "K" } } })
  clock = 20000
  await expect(feature.registry.reconcile()).resolves.toBeUndefined()
  expect(req(get("kid")).status).toBe("dead")
})

test("a trailing unanswered user prompt keeps the child derived-dead (restart orphan)", async () => {
  // An earlier finished answer must not mask a prompt the child never served:
  // that is exactly the orphan the nudge job resumes.
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    reconcileIntervalMs: 0,
    client: {
      session: {
        status: async () => ({ data: {} }),
        messages: async () => ({
          data: [
            { info: { id: "a1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "first answer" }] },
            { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "continue" }] },
          ],
        }),
      },
    },
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "kid", parentID: "p", title: "K" } } })
  clock = 20000
  await feature.tool.subagent_status.execute({})
  expect(req(get("kid")).status).toBe("dead")
})

test("concurrent reports share one reconcile pass", async () => {
  let clock = 5000
  let reconcileCalls = 0
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    reconcileIntervalMs: 0,
    client: {
      session: {
        status: async () => {
          reconcileCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { data: { c: { type: "busy" } } }
        },
      },
    },
  })
  feature.registry.ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })

  await Promise.all([feature.tool.subagent_status.execute({}), feature.tool.subagent_status.execute({})])
  expect(reconcileCalls).toBe(1)
})

test("progress and event clocks never move backwards from a slower overlapping pass", () => {
  let clock = 5000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({ type: "session.status", properties: { sessionID: "c", status: { type: "busy" } } })
  expect(req(get("c")).lastProgressAt).toBe(5000)

  // An out-of-order event carrying an older clock must not regress the record.
  clock = 4000
  ingest({ type: "session.status", properties: { sessionID: "c", status: { type: "busy" } } })
  expect(req(get("c")).lastProgressAt).toBe(5000)
  expect(req(get("c")).lastEventAt).toBe(5000)
})

test("session.updated for an untracked five-hour-old session is not a fresh clock", () => {
  const created = 1000
  const clock = created + 5 * 3600 * 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 600000 })
  feature.registry.ingest({
    type: "session.updated",
    properties: { info: { id: "old", parentID: "p", title: "O", time: { created, updated: created } } },
  })
  expect(req(feature.registry.get("old"))).toMatchObject({ status: "dead", lastProgressAt: created })
})

test("reconciliation is a silent no-op without SDK methods", async () => {
  const feature = createSubagentStatus({ now: () => 1000 })
  await expect(feature.registry.reconcile()).resolves.toBeUndefined()
  await expect(feature.registry.hydrate()).resolves.toBeUndefined()
})

test("report output carries an actionable hint per non-terminal child", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    toolGrace: () => 600000,
    reconcileIntervalMs: 0,
  })
  feature.registry.ingest({ type: "session.created", properties: { info: { id: "s", parentID: "p", title: "S" } } })
  feature.registry.ingest({ type: "session.created", properties: { info: { id: "d", parentID: "p", title: "D" } } })
  feature.registry.ingest({
    type: "message.part.updated",
    properties: { part: { sessionID: "d", type: "tool", tool: "bash", callID: "c", state: { status: "running", time: { start: 1000 } } } },
  })

  clock = 200_000
  const result = await feature.tool.subagent_status.execute({})
  // The long-running tool is called out as expected, not as something to cancel.
  expect(result.output).toContain('running tool "bash" for 3m')
  expect(result.output).toContain("expected for a long build")
  expect(result.metadata.counts.working).toBe(1)
})

test("ignores parent (top-level) sessions and filters by parent or status", async () => {
  const feature = createSubagentStatus({
    now: () => 0,
    threshold: () => 1000,
    deadThreshold: () => 100000,
    reconcileIntervalMs: 0,
  })
  const { ingest, report } = feature.registry

  ingest({ type: "session.created", properties: { info: { id: "top", title: "Parent", time: { created: 0 } } } })
  ingest({
    type: "session.created",
    properties: { info: { id: "a", parentID: "p1", title: "A", time: { created: 0 } } },
  })
  ingest({
    type: "session.created",
    properties: { info: { id: "b", parentID: "p2", title: "B", time: { created: 0 } } },
  })

  const all = feature.registry.snapshot()
  expect(all.map((item) => item.sessionID)).toEqual(["a", "b"])

  const filtered = feature.registry.snapshot({ parent: "p1" })
  expect(filtered).toHaveLength(1)
  expect(filtered[0].sessionID).toBe("a")

  const result = await report({ status: "running" })
  expect(result.counts).toEqual({ total: 2, running: 2, done: 0, error: 0, stale: 0, dead: 0, working: 0 })
})
