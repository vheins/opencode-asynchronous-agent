import { expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { elapsedLabel, subagentDetails } from "./subagent"

test("subagent reports its own model, active tool and actual todo counts", () => {
  const messages = [{
    info: { role: "assistant", providerID: "child-provider", modelID: "child-model", tokens: { input: 1000, output: 300, reasoning: 0, cache: { read: 200, write: 0 } }, time: { created: 1000 } } as Message,
    parts: [{ id: "part", sessionID: "child", messageID: "message", callID: "call", type: "tool", tool: "read", state: { status: "running", input: { filePath: "child/service.ts" }, time: { start: 1000 } } } as Part],
  }]
  const result = subagentDetails({ title: "Child session title", time: { created: 1000 } } as Session, messages, [{ content: "API", status: "completed", priority: "high" }, { content: "Tests", status: "in_progress", priority: "high" }], 3000)
  expect(result.model).toBe("child-provider / child-model")
  expect(result.title).toBe("Child session title")
  expect(result.current).toBe(true)
  expect(result.activity?.target).toBe("child/service.ts")
  expect(result.completed).toBe(1)
  expect(result.todos).toHaveLength(2)
  expect(result.toolCount).toBe(1)
  expect(result.used).toBe(1500)
  expect(result.output).toBe(300)
  expect(result.limit).toBe(3000)
  expect(result.percent).toBe(50)
  expect(elapsedLabel(result.started, 62000)).toBe("1m 1s")
  expect(elapsedLabel(result.started, 3662000)).toBe("1h 1m 1s")
})

test("unreported child model and progress do not inherit parent or invent a percentage", () => {
  const result = subagentDetails(undefined, [], [])
  expect(result).toMatchObject({ title: "Title not reported yet", model: "Model not reported yet", current: false, activity: undefined, completed: 0, todos: [] })
  expect(result.toolCount).toBe(0)
  expect(result.used).toBeUndefined()
  expect(result.output).toBeUndefined()
  expect(result.limit).toBeUndefined()
  expect(result.percent).toBeUndefined()
  expect(elapsedLabel(undefined, Date.now())).toBe("Duration not available yet")
  expect(elapsedLabel(10000, 5000)).toBe("0m 0s")
})
