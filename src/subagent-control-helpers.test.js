import { expect, test } from "bun:test"
import {
  clampText,
  controlEnabled,
  createSubagentControl,
  extractResult,
  mapSdkStatus,
  pickStatus,
  resolveTarget,
  sliceAfterCursor,
  unwrap,
} from "./subagent-control.js"
import { fakeClient, stubRegistry } from "./subagent-control-fixtures.js"

test("unwrap tolerates both { data } and bare payloads", () => {
  expect(unwrap({ data: [1, 2] })).toEqual([1, 2])
  expect(unwrap([1, 2])).toEqual([1, 2])
  expect(unwrap(undefined)).toBeUndefined()
  expect(unwrap({ ok: true })).toEqual({ ok: true })
})

test("pickStatus maps SDK types and defaults to unknown", () => {
  expect(pickStatus({ a: { type: "busy" } }, "a")).toEqual({ type: "running" })
  expect(pickStatus({ a: { type: "retry" } }, "a")).toEqual({ type: "running" })
  expect(pickStatus({ a: { type: "idle" } }, "a")).toEqual({ type: "done" })
  expect(pickStatus({ a: { type: "error" } }, "a")).toEqual({ type: "error" })
  // Never silently claim idle for a session the SDK did not report.
  expect(pickStatus({ a: { type: "busy" } }, "b")).toEqual({ type: "unknown" })
  expect(pickStatus(undefined, "a")).toEqual({ type: "unknown" })
  expect(mapSdkStatus("weird")).toBe("unknown")
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

test("sliceAfterCursor keeps only messages after the cursor", () => {
  const messages = [{ info: { id: "a" } }, { info: { id: "b" } }, { info: { id: "c" } }]
  expect(sliceAfterCursor(messages, "b")).toEqual([{ info: { id: "c" } }])
  expect(sliceAfterCursor(messages, undefined)).toEqual(messages)
  // Unknown cursor degrades to the full list.
  expect(sliceAfterCursor(messages, "zzz")).toEqual(messages)
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

test("the four base tools are registered without a registry", () => {
  const control = createSubagentControl({ client: fakeClient().client })
  expect(Object.keys(control.tool).sort()).toEqual([
    "subagent_cancel",
    "subagent_children",
    "subagent_result",
    "subagent_send",
  ])
})

test("subagent_watch is registered only when a registry exists", () => {
  const control = createSubagentControl({ client: fakeClient().client, registry: stubRegistry() })
  expect(Object.keys(control.tool).sort()).toEqual([
    "subagent_cancel",
    "subagent_children",
    "subagent_result",
    "subagent_send",
    "subagent_watch",
  ])
})

