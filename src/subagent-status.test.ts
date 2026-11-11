import { expect, test } from "bun:test"
import { activityOf, classifyStatus, createSubagentStatus, formatDuration, progressEvidenceAt } from "./subagent-status.js"

/** Assert a lookup produced a value, narrowing the type for the rest of the test. */
function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value")
  return value
}

test("classifyStatus uses two tiers: stale then dead", () => {
  const running = { status: "running", lastProgressAt: 1000 }
  expect(classifyStatus(running, 1500, 1000, 5000)).toBe("running")
  expect(classifyStatus(running, 2001, 1000, 5000)).toBe("stale")
  expect(classifyStatus(running, 5001, 1000, 5000)).toBe("stale")
  expect(classifyStatus(running, 6001, 1000, 5000)).toBe("dead")
  expect(classifyStatus({ status: "done", lastProgressAt: 0 }, 999999, 1000, 5000)).toBe("done")
  expect(classifyStatus({ status: "error", lastProgressAt: 0 }, 999999, 1000, 5000)).toBe("error")
  // A dead threshold of 0 disables the dead tier.
  expect(classifyStatus(running, 999999, 1000, 0)).toBe("stale")
})

test("classifyStatus reads the progress clock, never the event clock", () => {
  // Fresh bookkeeping event but ancient progress: still stale.
  expect(classifyStatus({ status: "running", lastProgressAt: 1000, lastEventAt: 999999 }, 3000, 1000, 10000)).toBe(
    "stale",
  )
})

test("classifyStatus revives a done record once progress advances", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 10000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({ type: "session.idle", properties: { sessionID: "c" } })
  expect(req(get("c"))).toMatchObject({ status: "done" })
  expect(req(get("c")).doneAt).toBe(1000)

  // Real revival path: a strong-progress event, not a hand-edited record.
  clock = 5000
  ingest({ type: "message.updated", properties: { info: { sessionID: "c", role: "assistant" } } })
  expect(req(get("c"))).toMatchObject({ status: "running", doneAt: undefined, lastProgressAt: 5000 })
  expect(classifyStatus({ status: "running", lastProgressAt: 5000 }, 5100, 1000, 10000)).toBe("running")
})

test("progressEvidenceAt prefers the newest in-flight tool start", () => {
  const record = { lastProgressAt: 1000, activeTools: new Map([["c1", { tool: "bash", startedAt: 9000 }]]) }
  expect(progressEvidenceAt(record)).toBe(9000)
  expect(progressEvidenceAt({ lastProgressAt: 1000, activeTools: new Map() })).toBe(1000)
})

test("progressEvidenceAt falls back to startedAt, never the weak event clock", () => {
  // A record missing the progress clock must not inherit `lastEventAt`: that
  // clock advances on weak events, which is the original zombie bug.
  expect(progressEvidenceAt({ startedAt: 1000, lastEventAt: 999999, activeTools: new Map() })).toBe(1000)
})

test("activityOf checks terminal states before in-flight tool state", () => {
  // A finished child with a leftover tool entry must read idle, so `counts.working`
  // cannot include it and the report never calls a done child "working".
  const withTool = new Map([["c1", { tool: "bash", startedAt: 9000 }]])
  expect(activityOf({ status: "done", lastProgressAt: 1000, activeTools: withTool }, 9500, 100000)).toBe("idle")
  expect(activityOf({ status: "error", lastProgressAt: 1000, activeTools: withTool }, 9500, 100000)).toBe("idle")
  // A live child with an in-flight tool still reads tool.
  expect(activityOf({ status: "running", lastProgressAt: 1000, activeTools: withTool }, 9500, 100000)).toBe("tool")
})

test("formatDuration renders compact elapsed labels", () => {
  expect(formatDuration(0)).toBe("0m 0s")
  expect(formatDuration(61000)).toBe("1m 1s")
  expect(formatDuration(3661000)).toBe("1h 1m 1s")
})

test("registry tracks a child through created, busy, stale, idle, error and deleted", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
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
  expect(snapshot()[0]).toMatchObject({ status: "running", agent: "backend", sinceLastProgressMs: 0 })

  ingest({ type: "session.idle", properties: { sessionID: "child-1" } })
  expect(snapshot()[0].status).toBe("done")

  ingest({ type: "session.error", properties: { sessionID: "child-1" } })
  expect(snapshot()[0].status).toBe("error")

  ingest({ type: "session.deleted", properties: { info: { id: "child-1", parentID: "parent-1" } } })
  expect(snapshot()).toHaveLength(0)
})

test("weak events refresh only the event clock", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({
    type: "session.created",
    properties: { info: { id: "c", parentID: "p", title: "C", time: { created: 1000 } } },
  })

  clock = 1500
  ingest({ type: "session.updated", properties: { info: { id: "c", parentID: "p", title: "Renamed" } } })
  expect(req(get("c"))).toMatchObject({ lastProgressAt: 1000, lastEventAt: 1500, title: "Renamed" })

  clock = 1600
  ingest({ type: "session.status", properties: { sessionID: "c", status: { type: "weird" } } })
  expect(req(get("c"))).toMatchObject({ lastProgressAt: 1000, lastEventAt: 1600, lastStatusType: "weird" })

  // Both weak events together still leave the child stale.
  clock = 2600
  expect(req(get("c")).status).toBe("stale")
})

test("session.created for an old session stamps its own created time, not now", () => {
  const clock = 1000 + 5 * 3600 * 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 600000 })
  feature.registry.ingest({
    type: "session.created",
    properties: { info: { id: "old", parentID: "p", title: "O", time: { created: 1000 } } },
  })
  expect(req(feature.registry.get("old"))).toMatchObject({ status: "dead", lastProgressAt: 1000 })
})

test("todo.updated is strong progress", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })

  clock = 1800
  ingest({ type: "todo.updated", properties: { sessionID: "c", todos: [] } })
  expect(req(get("c"))).toMatchObject({ lastProgressAt: 1800, status: "running" })
})

test("session.status busy revives a done record", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({ type: "session.idle", properties: { sessionID: "c" } })
  expect(req(get("c")).status).toBe("done")

  clock = 2000
  ingest({ type: "session.status", properties: { sessionID: "c", status: { type: "busy" } } })
  expect(req(get("c"))).toMatchObject({ status: "running", doneAt: undefined })
})

test("an in-flight tool call keeps a child running past stale AND dead thresholds", () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    toolGrace: () => 1800000,
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({
    type: "message.part.updated",
    properties: {
      part: {
        sessionID: "c",
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: { status: "running", time: { start: 1000 } },
      },
    },
  })

  // 20 minutes into a build, far past both thresholds.
  clock = 20 * 60000
  const item = req(get("c"))
  expect(item.status).toBe("running")
  expect(item.activity).toBe("tool")
  expect(item.activeTool).toEqual({ tool: "bash", runningMs: clock - 1000 })
  expect(item.sinceLastProgressMs).toBe(clock - 1000)
})

test("past the tool grace window a silent tool call degrades to dead", () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    toolGrace: () => 10000,
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", time: { start: 1000 } } },
    },
  })
  clock = 9000
  expect(req(get("c")).status).toBe("running")
  clock = 20000
  expect(req(get("c")).status).toBe("dead")
})

test("a completed tool call clears the tracker and advances progress", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", time: { start: 1000 } } },
    },
  })
  expect(req(get("c")).activeTool).not.toBeNull()

  clock = 5000
  ingest({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "completed", time: { start: 1000 } } },
    },
  })
  const item = req(get("c"))
  expect(item.activeTool).toBeNull()
  expect(item.activity).toBe("streaming")
  expect(item.lastProgressAt).toBe(5000)
  expect(item.status).toBe("running")
})

test("tool start is never overwritten by a repeated running event", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  const part = { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", time: { start: 1000 } } }
  ingest({ type: "message.part.updated", properties: { part } })
  clock = 3000
  ingest({ type: "message.part.updated", properties: { part: { ...part, state: { status: "running", time: { start: 3000 } } } } })
  expect(req(req(get("c")).activeTool).runningMs).toBe(2000)
})

test("a terminal transition clears the in-flight tool so a revived child cannot be pinned running", () => {
  // H1 regression: `session.idle` arrived while a tool part was still tracked as
  // running. A leftover entry used to report `activity: "tool"` on the finished
  // child and pin it at `running` for the whole tool-grace window after revival.
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    toolGrace: () => 1800000,
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", time: { start: 1000 } } },
    },
  })

  clock = 1500
  ingest({ type: "session.idle", properties: { sessionID: "c" } })
  expect(req(get("c"))).toMatchObject({ status: "done", activity: "idle", activeTool: null })

  // Revived with NO further events: the phantom tool must not keep it running.
  clock = 2000
  ingest({ type: "session.status", properties: { sessionID: "c", status: { type: "busy" } } })
  clock = 3001
  const item = req(get("c"))
  expect(item.activity).not.toBe("tool")
  expect(item.status).not.toBe("running")
})

test("a tool entry older than the grace window is pruned so it cannot pin the record", () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    toolGrace: () => 10000,
  })
  const { ingest, get } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  ingest({
    type: "message.part.updated",
    properties: {
      part: { sessionID: "c", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", time: { start: 1000 } } },
    },
  })
  // Past both the tool grace and the dead threshold with zero further events.
  clock = 30000
  const item = req(get("c"))
  expect(item.status).toBe("dead")
  expect(item.activeTool).toBeNull()
  expect(item.activity).toBe("idle")
})

test("snapshot exposes activity and activeTool shape", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, snapshot } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "idle", parentID: "p", title: "I" } } })
  ingest({ type: "session.created", properties: { info: { id: "stream", parentID: "p", title: "S" } } })
  ingest({ type: "session.created", properties: { info: { id: "tool", parentID: "p", title: "T" } } })

  clock = 2500
  ingest({ type: "message.updated", properties: { info: { sessionID: "stream", role: "assistant" } } })
  ingest({
    type: "message.part.updated",
    properties: { part: { sessionID: "tool", type: "tool", tool: "grep", callID: "k", state: { status: "pending", time: { start: 2500 } } } },
  })

  const byId = Object.fromEntries(snapshot().map((item) => [item.sessionID, item]))
  expect(req(byId.idle).activity).toBe("idle")
  expect(req(byId.idle).activeTool).toBeNull()
  expect(req(byId.stream).activity).toBe("streaming")
  expect(req(byId.tool).activity).toBe("tool")
  expect(req(byId.tool).activeTool).toEqual({ tool: "grep", runningMs: 0 })
})

test("sweep evicts stale and dead records past retention (no leak)", async () => {
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    retention: () => 10000,
    reconcileIntervalMs: 0,
  })
  const { ingest, report } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "zombie", parentID: "p", title: "Z" } } })
  ingest({ type: "session.created", properties: { info: { id: "live", parentID: "p", title: "L" } } })

  clock = 20000
  // Progress on the live child so it is not evictable.
  ingest({ type: "message.updated", properties: { info: { sessionID: "live", role: "assistant" } } })
  const result = await report()
  expect(result.items.map((item) => item.sessionID)).toEqual(["live"])
  expect(result.counts.dead).toBe(0)
})

test("registry.get and registry.classify expose one session", () => {
  let clock = 1000
  const feature = createSubagentStatus({ now: () => clock, threshold: () => 1000, deadThreshold: () => 100000 })
  const { ingest, get, classify } = feature.registry
  ingest({ type: "session.created", properties: { info: { id: "c", parentID: "p", title: "C" } } })
  expect(classify("c")).toBe("running")
  expect(get("c")).toMatchObject({ sessionID: "c", status: "running" })
  expect(get("nope")).toBeUndefined()
  expect(classify("nope")).toBeUndefined()
})
