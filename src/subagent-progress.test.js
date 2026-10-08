import { expect, test } from "bun:test"
import {
  PROGRESS_SYSTEM_INSTRUCTION,
  createSubagentProgress,
  formatProgressReport,
  formatProgressToast,
  isTerminalTodo,
  progressEnabled,
  progressIntervalMs,
  progressMode,
  shouldReport,
  summarizeTodos,
} from "./subagent-progress.js"

/** Fake SDK client capturing promptAsync/showToast calls and returning canned session info. */
function fakeClient(overrides = {}) {
  const calls = { promptAsync: [], get: [], showToast: [] }
  const sessions = overrides.sessions ?? {}
  const client = {
    session: {
      get: async (input) => {
        calls.get.push(input)
        return { data: sessions[input.path.id] }
      },
      promptAsync: async (input) => {
        calls.promptAsync.push(input)
        return { data: undefined }
      },
    },
    tui: {
      showToast: async (input) => {
        calls.showToast.push(input)
        return { data: true }
      },
    },
  }
  return { client, calls }
}

const TODOS = [
  { content: "a", status: "completed", priority: "high" },
  { content: "b", status: "in_progress", priority: "high" },
  { content: "c", status: "pending", priority: "low" },
]

test("progressEnabled reads the env gate", () => {
  const prev = process.env.OPENCODE_SUBAGENT_PROGRESS
  delete process.env.OPENCODE_SUBAGENT_PROGRESS
  expect(progressEnabled()).toBe(false)
  process.env.OPENCODE_SUBAGENT_PROGRESS = "1"
  expect(progressEnabled()).toBe(true)
  process.env.OPENCODE_SUBAGENT_PROGRESS = "0"
  expect(progressEnabled()).toBe(true)
  process.env.OPENCODE_SUBAGENT_PROGRESS = "maybe"
  expect(progressEnabled()).toBe(false)
  if (prev === undefined) delete process.env.OPENCODE_SUBAGENT_PROGRESS
  else process.env.OPENCODE_SUBAGENT_PROGRESS = prev
})

test("progressMode maps truthy to inject, falsy to toast, else off", () => {
  const prev = process.env.OPENCODE_SUBAGENT_PROGRESS
  delete process.env.OPENCODE_SUBAGENT_PROGRESS
  expect(progressMode()).toBe("off")
  process.env.OPENCODE_SUBAGENT_PROGRESS = "true"
  expect(progressMode()).toBe("inject")
  process.env.OPENCODE_SUBAGENT_PROGRESS = "0"
  expect(progressMode()).toBe("toast")
  process.env.OPENCODE_SUBAGENT_PROGRESS = "off"
  expect(progressMode()).toBe("toast")
  process.env.OPENCODE_SUBAGENT_PROGRESS = "nah"
  expect(progressMode()).toBe("off")
  if (prev === undefined) delete process.env.OPENCODE_SUBAGENT_PROGRESS
  else process.env.OPENCODE_SUBAGENT_PROGRESS = prev
})

test("progressIntervalMs defaults and honors a positive override", () => {
  const prev = process.env.OPENCODE_SUBAGENT_PROGRESS_MS
  delete process.env.OPENCODE_SUBAGENT_PROGRESS_MS
  expect(progressIntervalMs()).toBe(120000)
  process.env.OPENCODE_SUBAGENT_PROGRESS_MS = "30000"
  expect(progressIntervalMs()).toBe(30000)
  process.env.OPENCODE_SUBAGENT_PROGRESS_MS = "0"
  expect(progressIntervalMs()).toBe(120000)
  if (prev === undefined) delete process.env.OPENCODE_SUBAGENT_PROGRESS_MS
  else process.env.OPENCODE_SUBAGENT_PROGRESS_MS = prev
})

test("isTerminalTodo recognizes completed and cancelled only", () => {
  expect(isTerminalTodo({ status: "completed" })).toBe(true)
  expect(isTerminalTodo({ status: "cancelled" })).toBe(true)
  expect(isTerminalTodo({ status: "in_progress" })).toBe(false)
  expect(isTerminalTodo({ status: "pending" })).toBe(false)
  expect(isTerminalTodo(undefined)).toBe(false)
})

test("summarizeTodos counts each status and flags terminal", () => {
  const summary = summarizeTodos(TODOS)
  expect(summary.total).toBe(3)
  expect(summary.completed).toBe(1)
  expect(summary.inProgress).toBe(1)
  expect(summary.pending).toBe(1)
  expect(summary.terminal).toBe(false)
  expect(summary.text).toBe("1/3 done · 1 in_progress · 1 pending")

  const done = summarizeTodos([{ content: "a", status: "completed" }])
  expect(done.terminal).toBe(true)

  expect(summarizeTodos([]).total).toBe(0)
  expect(summarizeTodos([]).terminal).toBe(false)
})

test("formatProgressReport includes reporter, nickname, recipient, counts, and each todo line", () => {
  const text = formatProgressReport({ sessionID: "ses_child", agent: "frontend", nickname: "hidden-panda", parentAgent: "orchestrator", title: "T", todos: TODOS })
  expect(text).toContain("⤷ frontend · hidden-panda · reporting to orchestrator")
  expect(text).toContain("1/3 done")
  expect(text).toContain("- [in_progress] b")
})

test("formatProgressReport omits the nickname when the slug is unknown", () => {
  const text = formatProgressReport({ sessionID: "ses_child", agent: "frontend", parentAgent: "orchestrator", todos: TODOS })
  expect(text).toContain("⤷ frontend · reporting to orchestrator")
})

test("formatProgressToast puts identity in the title and the active todo in the message", () => {
  const toast = formatProgressToast({ sessionID: "ses_child", agent: "frontend", nickname: "hidden-panda", title: "Build checkout UI", todos: TODOS })
  expect(toast.title).toBe("⤷ frontend · hidden-panda · Build checkout UI")
  expect(toast.message).toBe("b")
  expect(toast.variant).toBe("info")
})

test("formatProgressToast falls back to counts when no todo is in progress", () => {
  const toast = formatProgressToast({ sessionID: "ses_child", agent: "frontend", todos: [{ content: "a", status: "completed" }] })
  expect(toast.title).toBe("⤷ frontend")
  expect(toast.message).toContain("1/1 done")
})

test("shouldReport sends final once, coalesces non-final by interval", () => {
  const summary = { terminal: false, text: "1/3 done" }
  expect(shouldReport(undefined, summary, 1000, 120000)).toBe(true)
  const state = { lastReportAt: 1000, lastText: "1/3 done", finalSent: false }
  expect(shouldReport(state, summary, 2000, 120000)).toBe(false)
  expect(shouldReport(state, { terminal: false, text: "2/3 done" }, 2000, 120000)).toBe(false)
  expect(shouldReport(state, { terminal: false, text: "2/3 done" }, 130001, 120000)).toBe(true)

  const final = { terminal: true, text: "3/3 done" }
  expect(shouldReport(undefined, final, 1000, 120000)).toBe(true)
  expect(shouldReport({ lastReportAt: 1000, lastText: "3/3 done", finalSent: true }, final, 999999, 120000)).toBe(false)
})

test("injects a visible report into the parent when a child updates todos", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator", model: { id: "m", providerID: "p" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "frontend", slug: "hidden-panda" },
    },
  })
  const progress = createSubagentProgress({ client, now: () => 1000, intervalMs: 120000 })
  await progress.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent", agent: "frontend", slug: "hidden-panda" } } } })
  await progress.event({ event: { type: "session.created", properties: { info: { id: "ses_parent", agent: "orchestrator" } } } })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(calls.promptAsync.length).toBe(1)
  const call = calls.promptAsync[0]
  expect(call.path.id).toBe("ses_parent")
  expect(call.body.agent).toBe("orchestrator")
  expect(call.body.parts[0].synthetic).toBeUndefined()
  expect(call.body.parts[0].text).toContain("⤷ frontend · hidden-panda · reporting to orchestrator")
})

test("resolves the child slug lazily via session.get when no event was seen", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" } } })
  const progress = createSubagentProgress({ client, now: () => 1000 })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(calls.promptAsync.length).toBe(1)
  expect(calls.promptAsync[0].body.parts[0].text).toContain("backend · mighty-island · reporting to ses_parent")
})

test("toast mode shows a toast instead of injecting a prompt", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator" },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "frontend", slug: "hidden-panda", title: "Build checkout UI" },
    },
  })
  const progress = createSubagentProgress({ client, now: () => 1000, intervalMs: 120000, mode: "toast" })
  await progress.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent", agent: "frontend", slug: "hidden-panda", title: "Build checkout UI" } } } })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(calls.promptAsync.length).toBe(0)
  expect(calls.showToast.length).toBe(1)
  const body = calls.showToast[0].body
  expect(body.title).toBe("⤷ frontend · hidden-panda · Build checkout UI")
  expect(body.message).toBe("b")
  expect(body.variant).toBe("info")
})

test("does not inject for a root session (no parent)", async () => {
  const { client, calls } = fakeClient({ sessions: {} })
  const progress = createSubagentProgress({ client, now: () => 1000 })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_root", todos: TODOS } } })
  expect(calls.promptAsync.length).toBe(0)
})

test("coalesces repeated updates within the interval and sends the final once", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_parent: {} } })
  let clock = 1000
  const progress = createSubagentProgress({ client, now: () => clock, intervalMs: 120000 })
  await progress.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent" } } } })

  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(calls.promptAsync.length).toBe(1)

  clock = 2000
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: [...TODOS, { content: "d", status: "pending" }] } } })
  expect(calls.promptAsync.length).toBe(1)

  clock = 130000
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: [...TODOS, { content: "d", status: "in_progress" }] } } })
  expect(calls.promptAsync.length).toBe(2)

  const allDone = TODOS.map((t) => ({ ...t, status: "completed" }))
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: allDone } } })
  expect(calls.promptAsync.length).toBe(3)

  clock = 999999
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: allDone } } })
  expect(calls.promptAsync.length).toBe(3)
})

test("resolves the parent lazily via session.get when no event was seen", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const progress = createSubagentProgress({ client, now: () => 1000 })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(calls.get.length).toBeGreaterThanOrEqual(1)
  expect(calls.get.some((call) => call.path.id === "ses_child")).toBe(true)
  expect(calls.promptAsync.length).toBe(1)
})

test("ignores an empty todo list", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { parentID: "ses_parent" } } })
  const progress = createSubagentProgress({ client, now: () => 1000 })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: [] } } })
  expect(calls.promptAsync.length).toBe(0)
})

test("does not throw when the SDK is unavailable", async () => {
  const progress = createSubagentProgress({ client: undefined, now: () => 1000 })
  await progress.event({ event: { type: "todo.updated", properties: { sessionID: "ses_child", todos: TODOS } } })
  expect(true).toBe(true)
})

test("systemTransform appends the instruction to child sessions only", async () => {
  const { client } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" }, ses_root: { id: "ses_root" } } })
  const progress = createSubagentProgress({ client, now: () => 1000 })

  const childOutput = { system: ["base"] }
  await progress.systemTransform({ sessionID: "ses_child" }, childOutput)
  expect(childOutput.system).toEqual(["base", PROGRESS_SYSTEM_INSTRUCTION])

  const rootOutput = { system: ["base"] }
  await progress.systemTransform({ sessionID: "ses_root" }, rootOutput)
  expect(rootOutput.system).toEqual(["base"])

  const noId = { system: ["base"] }
  await progress.systemTransform({}, noId)
  expect(noId.system).toEqual(["base"])
})

test("systemTransform uses the registry without an SDK lookup", async () => {
  const { client, calls } = fakeClient({ sessions: {} })
  const progress = createSubagentProgress({ client, now: () => 1000 })
  await progress.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent" } } } })
  const before = calls.get.length
  const output = { system: [] }
  await progress.systemTransform({ sessionID: "ses_child" }, output)
  expect(output.system).toEqual([PROGRESS_SYSTEM_INSTRUCTION])
  expect(calls.get.length).toBe(before)
})

test("systemTransform caches a root session and stops looking it up", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_root: { id: "ses_root" } } })
  const progress = createSubagentProgress({ client, now: () => 1000 })

  const first = { system: [] }
  await progress.systemTransform({ sessionID: "ses_root" }, first)
  expect(first.system).toEqual([])
  expect(calls.get.length).toBe(1)

  const second = { system: [] }
  await progress.systemTransform({ sessionID: "ses_root" }, second)
  expect(second.system).toEqual([])
  expect(calls.get.length).toBe(1)
})
