import { expect, test } from "bun:test"
import {
  completionChannel,
  createSubagentCompletion,
  formatCompletionNotice,
  formatCompletionToast,
} from "./subagent-completion.js"

/** Fake SDK client capturing promptAsync/prompt/showToast calls and returning canned session info. */
function fakeClient(overrides = {}) {
  const calls = { promptAsync: [], prompt: [], get: [], showToast: [] }
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
      prompt: async (input) => {
        calls.prompt.push(input)
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

test("completionChannel is decoupled from progress and defaults to inline", () => {
  const prev = { p: process.env.OPENCODE_SUBAGENT_PROGRESS, c: process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY }
  delete process.env.OPENCODE_SUBAGENT_PROGRESS
  delete process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY
  // Waking default: never silenced by the progress channel.
  expect(completionChannel()).toBe("inline")
  // Changing the progress channel does NOT change completion.
  process.env.OPENCODE_SUBAGENT_PROGRESS = "1"
  expect(completionChannel()).toBe("inline")
  process.env.OPENCODE_SUBAGENT_PROGRESS = "0"
  expect(completionChannel()).toBe("inline")
  process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY = "both"
  expect(completionChannel()).toBe("both")
  process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY = "off"
  expect(completionChannel()).toBe("off")
  if (prev.p === undefined) delete process.env.OPENCODE_SUBAGENT_PROGRESS
  else process.env.OPENCODE_SUBAGENT_PROGRESS = prev.p
  if (prev.c === undefined) delete process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY
  else process.env.OPENCODE_SUBAGENT_COMPLETION_NOTIFY = prev.c
})

test("formatCompletionNotice carries the child identity and the follow-up wording", () => {
  const text = formatCompletionNotice({ sessionID: "ses_child", agent: "backend", nickname: "mighty-island", title: "Do work" })
  expect(text).toContain("⤷ backend · mighty-island · \"Do work\" · follow-up completed (ses_child)")
  expect(text).toContain("subagent_result")
})

test("formatCompletionToast puts identity in the title and a short message", () => {
  const toast = formatCompletionToast({ sessionID: "ses_child", agent: "backend", nickname: "mighty-island", title: "Do work" })
  expect(toast.title).toBe("⤷ backend · mighty-island · Do work")
  expect(toast.message).toBe("follow-up completed")
  expect(toast.variant).toBe("info")
})

test("inline channel injects a NON-synthetic completion notice into the parent on child idle", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator", model: { id: "m", providerID: "p" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" },
    },
  })
  const completion = createSubagentCompletion({ client, channel: "inline" })
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

test("chat channel sends a hidden no-reply part (no model turn)", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" } },
  })
  const completion = createSubagentCompletion({ client, channel: "chat" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
  expect(calls.showToast.length).toBe(0)
  expect(calls.prompt.length).toBe(1)
  expect(calls.prompt[0].path.id).toBe("ses_parent")
  expect(calls.prompt[0].body.noReply).toBe(true)
  expect(calls.prompt[0].body.parts[0].ignored).toBe(true)
})

test("toast channel shows a toast and injects nothing", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" } },
  })
  const completion = createSubagentCompletion({ client, channel: "toast" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
  expect(calls.prompt.length).toBe(0)
  expect(calls.showToast.length).toBe(1)
  expect(calls.showToast[0].body.variant).toBe("info")
})

test("both channel fires toast AND inline independently", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" } },
  })
  const completion = createSubagentCompletion({ client, channel: "both" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.showToast.length).toBe(1)
  expect(calls.promptAsync.length).toBe(1)
})

test("fires on session.status{type:'idle'} as well as session.idle", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, channel: "inline" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } } })
  expect(calls.promptAsync.length).toBe(1)
})

test("the registration is one-shot: a later idle does not re-fire", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, channel: "inline" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  await completion.event({ event: { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } } })
  expect(calls.promptAsync.length).toBe(1)
})

test("injects nothing when the feature is disabled", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, channel: "inline", enabled: false })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
})

test("injects nothing for an unregistered child (initial dispatch is untouched)", async () => {
  const { client, calls } = fakeClient({ sessions: { ses_child: { id: "ses_child", parentID: "ses_parent" } } })
  const completion = createSubagentCompletion({ client, channel: "inline" })
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(0)
})

test("caches the child identity so repeated follow-ups skip the session.get", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" } },
  })
  const completion = createSubagentCompletion({ client, channel: "inline" })

  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(1)
  const childGets = () => calls.get.filter((call) => call.path.id === "ses_child").length
  expect(childGets()).toBe(1)

  // A second follow-up to the SAME child reuses the cached identity.
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(2)
  expect(childGets()).toBe(1)
})
