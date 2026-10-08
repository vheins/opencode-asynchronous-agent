import { expect, test } from "bun:test"
import { sidebarActivity } from "./model"

function fakeApi(status: { type: string } | undefined) {
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
        todo: () => [],
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

test("an idle child stays visible and is labelled Idle", () => {
  const agents = sidebarActivity(fakeApi({ type: "idle" }), "ses_parent").agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ name: "Frontend", label: "Idle", active: false })
})

test("a child with no reported status is treated as idle but still listed", () => {
  const agents = sidebarActivity(fakeApi(undefined), "ses_parent").agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ name: "Frontend", label: "Idle", active: false })
})
