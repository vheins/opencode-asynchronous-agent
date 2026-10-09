import { expect, test } from "bun:test"
import { createSubagentCompletion, formatCompletionNotice } from "./subagent-completion.js"

/** Fake SDK client capturing promptAsync calls and returning canned session info. */
function fakeClient(overrides = {}) {
  const calls = { promptAsync: [], get: [] }
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
  }
  return { client, calls }
}

test("formatCompletionNotice carries the child identity and the follow-up wording", () => {
  const text = formatCompletionNotice({ sessionID: "ses_child", agent: "backend", nickname: "mighty-island", title: "Do work" })
  expect(text).toContain("⤷ backend · mighty-island · \"Do work\" · follow-up completed (ses_child)")
  expect(text).toContain("subagent_result")
})

test("injects a NON-synthetic completion notice into the parent on child idle", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator", model: { id: "m", providerID: "p" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" },
    },
  })
  const completion = createSubagentCompletion({ client, enabled: true })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })

  expect(calls.promptAsync.length).toBe(1)
  const call = calls.promptAsync[0]
  expect(call.path.id).toBe("ses_parent")
  expect(call.body.agent).toBe("orchestrator")
  // Regression (TASK-001): the part MUST be non-synthetic, else the parent TUI
  // hides it (see src/subagent-progress.js:14-15).
  expect(call.body.parts[0].synthetic).toBeUndefined()
  expect(call.body.parts[0].text).toContain("⤷ backend · mighty-island · follow-up completed")
})

test("fires on session.status{type:'idle'} as well as session.idle", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, enabled: true })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } } })
  expect(calls.promptAsync.length).toBe(1)
})

test("the registration is one-shot: a later idle does not re-fire", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, enabled: true })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  await completion.event({ event: { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } } })
  expect(calls.promptAsync.length).toBe(1)
})

test("injects nothing when the feature is disabled", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, enabled: false })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
})

test("injects nothing for an unregistered child (initial dispatch is untouched)", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, enabled: true })
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
})
