import { expect, test } from "bun:test"
import {
  completionChannel,
  createSubagentCompletion,
  formatCompletionMetadata,
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

test("formatCompletionNotice is two dense lines with outcome, duration, calls, ctx, title and the id once", () => {
  const text = formatCompletionNotice({
    sessionID: "ses_e36c2afedffeG0bcjZWB9TK9Kp",
    agent: "backend",
    nickname: "witty-river",
    title: "Fix sort order and split tests",
    outcome: "done",
    elapsedMs: 12 * 60_000 + 4_000,
    toolCalls: 21,
    tokens: { input: 40_000, output: 6_000, reasoning: 1_000, cache: { read: 1_000, write: 100 } },
  })
  const lines = text.split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe(
    '⤷ witty-river · backend · done in 12m04s · 21 calls · 48.1k ctx · "Fix sort order and split tests"',
  )
  expect(lines[1]).toBe("  → subagent_result sessionID=ses_e36c2afedffeG0bcjZWB9TK9Kp")
  // The session id appears once, on the call hint only.
  expect(text.split("ses_e36c2afedffeG0bcjZWB9TK9Kp")).toHaveLength(2)
})

test("formatCompletionNotice strips the redundant (@agent subagent) title suffix", () => {
  const text = formatCompletionNotice({
    sessionID: "ses_child",
    agent: "backend",
    nickname: "mighty-island",
    title: "Fix sort order and split tests (@backend subagent)",
  })
  expect(text).toContain('"Fix sort order and split tests"')
  expect(text).not.toContain("(@backend subagent)")
  // Agent printed once, as the identity segment.
  expect(text.split("backend")).toHaveLength(2)
})

test("formatCompletionNotice renders `error` (never `completed`) for an errored child", () => {
  const text = formatCompletionNotice({
    sessionID: "ses_err",
    agent: "backend",
    nickname: "witty-river",
    title: "Fix sort order and split tests",
    outcome: "error",
    elapsedMs: 4 * 60_000 + 12_000,
    toolCalls: 8,
  })
  expect(text.split("\n")[0]).toBe(
    '⤷ witty-river · backend · error in 4m12s · 8 calls · "Fix sort order and split tests"',
  )
  expect(text).toContain("(terminal error)")
  expect(text).not.toContain("completed")
})

test("formatCompletionNotice omits unknown segments instead of printing placeholders", () => {
  const text = formatCompletionNotice({ sessionID: "ses_child", agent: "backend", nickname: "witty-river" })
  expect(text.split("\n")[0]).toBe("⤷ witty-river · backend · done")
  expect(text).not.toContain("?")
  expect(text).not.toContain("n/a")
  expect(text).not.toContain("ctx")
  expect(text).not.toContain("calls")
})

test("formatCompletionNotice carries no instruction boilerplate", () => {
  const text = formatCompletionNotice({
    sessionID: "ses_child",
    agent: "backend",
    nickname: "witty-river",
    title: "Do work",
    outcome: "done",
    elapsedMs: 1000,
    toolCalls: 1,
    contextUsed: 1200,
  })
  expect(text).not.toContain("finished processing")
  expect(text).not.toContain("Read its answer with")
  expect(text).not.toContain("follow-up completed")
  expect(text).toContain("1 call")
})

test("formatCompletionToast carries identity and outcome in the title and the facts in the message", () => {
  const toast = formatCompletionToast({
    sessionID: "ses_child",
    agent: "backend",
    nickname: "mighty-island",
    title: "Do work",
    outcome: "done",
    elapsedMs: 38_000,
    toolCalls: 3,
    contextUsed: 12_300,
  })
  expect(toast.title).toBe("⤷ mighty-island · backend · done")
  expect(toast.message).toBe('38s · 3 calls · 12.3k ctx · "Do work"')
  expect(toast.variant).toBe("info")
})

test("formatCompletionMetadata exposes the structured shape and fails safe without a registry", () => {
  const meta = formatCompletionMetadata({
    sessionID: "ses_child",
    agent: "backend",
    nickname: "witty-river",
    title: "Do work (@backend subagent)",
    outcome: "done",
    elapsedMs: 5000,
    toolCalls: 2,
    contextUsed: 900,
  })
  expect(meta).toEqual({
    sessionID: "ses_child",
    slug: "witty-river",
    agent: "backend",
    outcome: "done",
    elapsedMs: 5000,
    toolCalls: 2,
    tokens: undefined,
    contextUsed: 900,
    title: "Do work",
  })

  // A registry that throws must not break rendering.
  const throwing = { get: () => { throw new Error("boom") } }
  expect(() => formatCompletionNotice({ sessionID: "ses_child", agent: "backend", registry: throwing })).not.toThrow()
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
  expect(call.body.parts[0].text).toContain("⤷ mighty-island · backend · done")
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
  let clock = 0
  const completion = createSubagentCompletion({ client, channel: "inline", now: () => clock })

  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(1)
  const childGets = () => calls.get.filter((call) => call.path.id === "ses_child").length
  expect(childGets()).toBe(1)

  // A second follow-up to the SAME child reuses the cached identity (past the
  // dedupe window, so it is a distinct notice).
  clock = 60_000
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(2)
  expect(childGets()).toBe(1)
})

test("suppresses a duplicate notice for the same child inside the dedupe window", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" } },
  })
  let clock = 0
  const completion = createSubagentCompletion({ client, channel: "inline", now: () => clock, dedupeMs: 5000 })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(1)
  // Second arm + idle within the window: suppressed.
  clock = 1000
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(1)
})

test("the registry supplies outcome, duration, calls and context when present", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "witty-river" } },
  })
  const registry = {
    get: (id) =>
      id === "ses_child"
        ? {
            status: "error",
            agent: "backend",
            slug: "witty-river",
            title: "Fix sort order (@backend subagent)",
            elapsedMs: 252_000,
            toolCalls: 8,
            tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            contextUsed: 1200,
          }
        : undefined,
  }
  const completion = createSubagentCompletion({ client, channel: "inline", registry })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })

  const part = calls.promptAsync[0].body.parts[0]
  expect(part.text.split("\n")[0]).toBe('⤷ witty-river · backend · error in 4m12s · 8 calls · 1.2k ctx · "Fix sort order"')
  expect(part.text).toContain("(terminal error)")
  expect(part.metadata).toEqual({
    sessionID: "ses_child",
    slug: "witty-river",
    agent: "backend",
    outcome: "error",
    elapsedMs: 252_000,
    toolCalls: 8,
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    contextUsed: 1200,
    title: "Fix sort order",
  })
})

test("a missing registry still renders from SDK identity without throwing", async () => {
  const { client, calls } = fakeClient({
    sessions: { ses_parent: { id: "ses_parent" }, ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" } },
  })
  const completion = createSubagentCompletion({ client, channel: "inline" })
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  const text = calls.promptAsync[0].body.parts[0].text
  expect(text.split("\n")[0]).toBe("⤷ mighty-island · backend · done")
  expect(text).toContain("sessionID=ses_child")
})

test("the pending registration expires after the TTL so a never-idle child cannot leak", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator", model: { id: "m", providerID: "p" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" },
    },
  })
  let clock = 0
  const completion = createSubagentCompletion({
    client,
    channel: "inline",
    now: () => clock,
    pendingTtlMs: 1000,
  })
  completion.onSend("ses_parent", "ses_child")
  // Advance past the TTL, then deliver an event for another session to trigger pruning.
  clock = 5000
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_other" } } })
  // The expired registration must not fire.
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync).toHaveLength(0)
})

test("a registration inside the TTL still fires", async () => {
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent", agent: "orchestrator", model: { id: "m", providerID: "p" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend" },
    },
  })
  let clock = 0
  const completion = createSubagentCompletion({
    client,
    channel: "inline",
    now: () => clock,
    pendingTtlMs: 10000,
  })
  completion.onSend("ses_parent", "ses_child")
  clock = 5000
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync).toHaveLength(1)
})

test("the cached child identity expires after the TTL and is re-fetched", async () => {
  // Regression: `identities` previously kept one entry per child for the process
  // lifetime. It now ages out on the same TTL clock as `pending`.
  const { client, calls } = fakeClient({
    sessions: {
      ses_parent: { id: "ses_parent" },
      ses_child: { id: "ses_child", parentID: "ses_parent", agent: "backend", slug: "mighty-island" },
    },
  })
  let clock = 0
  const completion = createSubagentCompletion({ client, channel: "inline", now: () => clock, pendingTtlMs: 1000 })
  const childGets = () => calls.get.filter((call) => call.path.id === "ses_child").length

  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(childGets()).toBe(1)

  // Another child's event past the TTL prunes the expired identity cache.
  clock = 5000
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_other" } } })

  // A later follow-up to the original child must fetch identity again.
  clock = 6000
  completion.onSend("ses_parent", "ses_child")
  await completion.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(calls.promptAsync.length).toBe(2)
  expect(childGets()).toBe(2)
})
