import { expect, test } from "bun:test"
import { STATUS_ORDER, statusRank } from "./subagent-format.js"
import { STATUS_RANK } from "./subagent-liveness.js"
import { createSubagentStatus } from "./subagent-status.js"
import { createSubagentControl } from "./subagent-control.js"

/**
 * Triage order shared by both tools: live work first, then work needing
 * attention, then finished work, unknown last.
 */
const EXPECTED_ORDER = ["running", "stale", "dead", "error", "done", "unknown"]

test("STATUS_RANK aliases the single canonical STATUS_ORDER table", () => {
  // Identity, not equality: a second literal with the same numbers today is
  // exactly how the two tools drifted apart before.
  expect(STATUS_RANK).toBe(STATUS_ORDER)
  expect(Object.entries(STATUS_ORDER).sort((a, b) => a[1] - b[1]).map(([status]) => status)).toEqual(EXPECTED_ORDER)
})

test("statusRank ranks every status in canonical order and sorts unknown/missing last", () => {
  for (let index = 1; index < EXPECTED_ORDER.length; index += 1) {
    expect(statusRank(EXPECTED_ORDER[index - 1])).toBeLessThan(statusRank(EXPECTED_ORDER[index]))
  }
  expect(statusRank("unknown")).toBe(STATUS_ORDER.unknown)
  // A status the table does not know must never sort before a known one.
  expect(statusRank(undefined)).toBe(STATUS_ORDER.unknown)
  expect(statusRank("weird")).toBe(STATUS_ORDER.unknown)
  expect(statusRank("weird")).toBeGreaterThan(statusRank("running"))
})

/** Minimal registry surface the children tool reads: a snapshot list. */
function stubRegistry(items) {
  return { snapshot: () => items, get: () => undefined, classify: () => undefined }
}

/** A child row with only the fields the children tool renders and sorts on. */
function row(sessionID, status) {
  return { sessionID, status, title: status, startedAt: 1000, elapsedMs: 1000, todo: null, activeTool: null }
}

test("subagent_children and subagent_status agree on the relative order of a mixed child tree", async () => {
  // --- children: every status, including the SDK-only `unknown` ---
  const childrenRegistry = stubRegistry(EXPECTED_ORDER.map((status) => row(`ses_${status}`, status)))
  const control = createSubagentControl({ client: { session: {} }, registry: childrenRegistry })
  const children = await control.tool.subagent_children.execute({})
  const childrenOrder = children.metadata.children.map((item) => item.status)
  expect(childrenOrder).toEqual(EXPECTED_ORDER)

  // --- status: a real registry driven through the event stream ---
  // Thresholds: stale at 1000 ms without progress, dead at 5000 ms.
  let clock = 1000
  const feature = createSubagentStatus({
    now: () => clock,
    threshold: () => 1000,
    deadThreshold: () => 5000,
    retention: () => 3600000,
    reconcileIntervalMs: 0,
  })
  const { ingest } = feature.registry
  for (const status of ["running", "stale", "dead", "done", "error"]) {
    ingest({ type: "session.created", properties: { info: { id: `ses_${status}`, parentID: "p", title: status } } })
  }
  // Stamp progress so each child lands in a distinct liveness tier at clock 7000:
  // run = 500 ms old (running), stale = 3000 ms (stale), dead = 6000 ms (dead).
  clock = 4000
  ingest({ type: "message.updated", properties: { info: { sessionID: "ses_stale", role: "assistant" } } })
  clock = 6500
  ingest({ type: "message.updated", properties: { info: { sessionID: "ses_running", role: "assistant" } } })
  clock = 7000
  ingest({ type: "session.idle", properties: { sessionID: "ses_done" } })
  ingest({ type: "session.error", properties: { sessionID: "ses_error" } })

  const statuses = (await feature.tool.subagent_status.execute({})).metadata.subagents.map((item) => item.status)
  expect(statuses).toEqual(["running", "stale", "dead", "error", "done"])
  // The same relative order as the children tool for every status they share.
  expect(statuses).toEqual(childrenOrder.filter((status) => statuses.includes(status)))
  // Done is last among finished work even when an error exists.
  expect(statuses.indexOf("error")).toBeLessThan(statuses.indexOf("done"))
})
