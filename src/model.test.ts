import { expect, test } from "bun:test"
import { sidebarActivity } from "./model"

function fakeApi(status: { type: string } | undefined, todos: { status: string }[] = []) {
  const part = {
    id: "prt_1",
    type: "tool",
    tool: "task",
    callID: "call_1",
    state: {
      status: "completed",
      metadata: { sessionId: "ses_child", background: true },
      input: { subagent_type: "Frontend", description: "Build UI" },
      output: "",
      title: "",
      time: { start: 0, end: 10 },
    },
  }
  const message = { id: "msg_1", role: "assistant" }
  return {
    state: {
      session: {
        messages: () => [message],
        status: (id: string) => (id === "ses_child" ? status : undefined),
        permission: () => [],
        question: () => [],
        todo: (id: string) => (id === "ses_child" ? todos : []),
      },
      part: () => [part],
      mcp: () => [],
    },
  } as any
}

test("a busy child is listed as Working and active", () => {
  const agents = sidebarActivity(fakeApi({ type: "busy" }), "ses_parent").agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ name: "Frontend", label: "Working", active: true })
})

test("an idle child stays visible and is labelled Done", () => {
  const agents = sidebarActivity(fakeApi({ type: "idle" }), "ses_parent").agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ name: "Frontend", label: "Done", active: false })
})

test("a child with no reported status is treated as done but still listed", () => {
  const agents = sidebarActivity(fakeApi(undefined), "ses_parent").agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ name: "Frontend", label: "Done", active: false })
})

test("a child's todo progress is surfaced as completed/total", () => {
  const todos = [
    { status: "completed" },
    { status: "completed" },
    { status: "in_progress" },
    { status: "pending" },
  ]
  const agents = sidebarActivity(fakeApi({ type: "busy" }, todos), "ses_parent").agents
  expect(agents[0].progress).toEqual({ completed: 2, inProgress: 1, total: 4 })
})

test("running agents are ordered before finished ones", () => {
  const task = (callID: string, sessionId: string, subagent: string) => ({
    id: callID,
    type: "tool",
    tool: "task",
    callID,
    state: {
      status: "completed",
      metadata: { sessionId, background: true },
      input: { subagent_type: subagent, description: "Work" },
      output: "",
      title: "",
      time: { start: 0, end: 10 },
    },
  })
  const statuses: Record<string, { type: string } | undefined> = {
    ses_done: { type: "idle" },
    ses_live: { type: "busy" },
  }
  const parts = [task("call_done", "ses_done", "Done1"), task("call_live", "ses_live", "Live1"), task("call_done2", "ses_done2", "Done2")]
  const api = {
    state: {
      session: {
        messages: () => [{ id: "msg_1", role: "assistant" }],
        status: (id: string) => statuses[id],
        permission: () => [],
        question: () => [],
        todo: () => [],
      },
      part: () => parts,
      mcp: () => [],
    },
  } as any
  const agents = sidebarActivity(api, "ses_parent").agents
  expect(agents.map((agent) => agent.name)).toEqual(["Live1", "Done1", "Done2"])
  expect(agents[0].active).toBe(true)
})
