import { expect, test } from "bun:test"
import { classifyStatus, createSubagentStatus, formatDuration } from "./subagent-status.js"

test("classifyStatus derives stale from a running record past the threshold", () => {
  const running = { status: "running", lastEventAt: 1000 }
  expect(classifyStatus(running, 1500, 1000)).toBe("running")
  expect(classifyStatus(running, 2001, 1000)).toBe("stale")
  expect(classifyStatus({ status: "done", lastEventAt: 0 }, 999999, 1000)).toBe("done")
  expect(classifyStatus({ status: "error", lastEventAt: 0 }, 999999, 1000)).toBe("error")
})

test("formatDuration renders compact elapsed labels", () => {
  expect(formatDuration(0)).toBe("0m 0s")
  expect(formatDuration(61000)).toBe("1m 1s")
  expect(formatDuration(3661000)).toBe("1h 1m 1s")
})

test("registry tracks a child through created, busy, stale, idle, error and deleted", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000 })
  const { ingest, snapshot } = feature.registry

  ingest({
    type: "session.created",
    properties: { info: { id: "child-1", parentID: "parent-1", title: "Child", time: { created: 1000 } } },
  })
  ingest({ type: "session.status", properties: { sessionID: "child-1", status: { type: "busy" } } })
  expect(snapshot()[0]).toMatchObject({ sessionID: "child-1", parentID: "parent-1", status: "running", stale: false })

  clock = 2500
  expect(snapshot()[0].status).toBe("stale")

  ingest({ type: "message.updated", properties: { info: { sessionID: "child-1", role: "assistant", agent: "backend" } } })
  expect(snapshot()[0]).toMatchObject({ status: "running", agent: "backend", sinceLastEventMs: 0 })

  ingest({ type: "session.idle", properties: { sessionID: "child-1" } })
  expect(snapshot()[0].status).toBe("done")

  ingest({ type: "session.error", properties: { sessionID: "child-1" } })
  expect(snapshot()[0].status).toBe("error")

  ingest({ type: "session.deleted", properties: { info: { id: "child-1", parentID: "parent-1" } } })
  expect(snapshot()).toHaveLength(0)
})

test("ignores parent (top-level) sessions and filters by parent or status", () => {
  const feature = createSubagentStatus({ now: () => 0, threshold: () => 1000 })
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

  return report({ status: "running" }).then((result) => {
    expect(result.counts).toEqual({ total: 2, running: 2, done: 0, error: 0, stale: 0 })
  })
})
