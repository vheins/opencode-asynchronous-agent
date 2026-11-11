import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  DEFAULT_NUDGE_AFTER_MS,
  DEFAULT_NUDGE_CHECK_MS,
  DEFAULT_NUDGE_MAX,
  DEFAULT_NUDGE_PROMPT,
  MAX_NUDGES_PER_TICK,
  createSubagentNudge,
  nudgeAfterMs,
  nudgeCheckMs,
  nudgeDebug,
  nudgeEnabled,
  nudgeMax,
  nudgePrompt,
} from "./subagent-nudge.js"

/** Env keys this suite mutates; restored after each test. */
const ENV_KEYS = [
  "OPENCODE_SUBAGENT_NUDGE",
  "OPENCODE_SUBAGENT_NUDGE_AFTER_MS",
  "OPENCODE_SUBAGENT_NUDGE_MAX",
  "OPENCODE_SUBAGENT_NUDGE_CHECK_MS",
  "OPENCODE_SUBAGENT_NUDGE_PROMPT",
  "OPENCODE_SUBAGENT_NUDGE_DEBUG",
]

let savedEnv

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // Small deterministic budgets: 1s staleness gate, 2 attempts per child.
  process.env.OPENCODE_SUBAGENT_NUDGE_AFTER_MS = "1000"
  process.env.OPENCODE_SUBAGENT_NUDGE_MAX = "2"
  process.env.OPENCODE_SUBAGENT_NUDGE_CHECK_MS = "60000"
  delete process.env.OPENCODE_SUBAGENT_NUDGE_PROMPT
  delete process.env.OPENCODE_SUBAGENT_NUDGE_DEBUG
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/**
 * Stub SDK client. `statuses` is the map returned by `session.status`; `infos`
 * maps a session id to the object `session.get` returns.
 */
function fakeClient({ statuses = {}, infos = {}, statusThrows = false, promptThrows = false, getThrows = false } = {}) {
  const calls = { status: 0, get: [], promptAsync: [] }
  const client = {
    session: {
      status: async () => {
        calls.status += 1
        if (statusThrows) throw new Error("status boom")
        return { data: statuses }
      },
      get: async (input) => {
        calls.get.push(input)
        if (getThrows) throw new Error("get boom")
        return { data: infos[input.path.id] }
      },
      promptAsync: async (input) => {
        calls.promptAsync.push(input)
        if (promptThrows) throw new Error("prompt boom")
        return { data: undefined }
      },
    },
  }
  return { client, calls }
}

/** Stub registry: serves a mutable snapshot and records synthetic events. */
function fakeRegistry(items = []) {
  const events = []
  const state = { items: [...items], hydrateCalls: 0, afterHydrate: undefined }
  const registry = {
    snapshot: () => state.items,
    hydrate: async () => {
      state.hydrateCalls += 1
      if (state.afterHydrate) state.items = state.afterHydrate
    },
    ingest: (event) => events.push(event),
  }
  return { registry, state, events }
}

/** A stale, idle child record: the only shape eligible for a nudge. */
function staleItem(id, extra = {}) {
  return {
    sessionID: id,
    parentID: "parent-1",
    title: id,
    status: "stale",
    activity: "idle",
    sinceLastProgressMs: 5000,
    ...extra,
  }
}

/**
 * A child whose staleness is derived from a fixed `lastProgressAt`, so it keeps
 * aging as the injected clock advances (mirrors a real registry record).
 */
function agingItem(id, lastProgressAt, extra = {}) {
  return staleItem(id, { sinceLastProgressMs: undefined, lastProgressAt, ...extra })
}

test("env readers fall back to their documented defaults", () => {
  for (const key of ENV_KEYS) delete process.env[key]
  expect(nudgeEnabled()).toBe(false)
  expect(nudgeAfterMs()).toBe(DEFAULT_NUDGE_AFTER_MS)
  expect(nudgeMax()).toBe(DEFAULT_NUDGE_MAX)
  expect(nudgeCheckMs()).toBe(DEFAULT_NUDGE_CHECK_MS)
  expect(nudgePrompt()).toBe(DEFAULT_NUDGE_PROMPT)
  expect(nudgeDebug()).toBe(false)

  process.env.OPENCODE_SUBAGENT_NUDGE = "YES"
  expect(nudgeEnabled()).toBe(true)
  process.env.OPENCODE_SUBAGENT_NUDGE_AFTER_MS = "2500"
  process.env.OPENCODE_SUBAGENT_NUDGE_MAX = "4"
  process.env.OPENCODE_SUBAGENT_NUDGE_CHECK_MS = "5000"
  process.env.OPENCODE_SUBAGENT_NUDGE_PROMPT = "  resume now  "
  process.env.OPENCODE_SUBAGENT_NUDGE_DEBUG = "1"
  expect(nudgeAfterMs()).toBe(2500)
  expect(nudgeMax()).toBe(4)
  expect(nudgeCheckMs()).toBe(5000)
  expect(nudgePrompt()).toBe("resume now")
  expect(nudgeDebug()).toBe(true)
})

test("an orphan absent from the status map is nudged once, keeping its identity", async () => {
  let clock = 1_000_000
  const { client, calls } = fakeClient({
    statuses: {},
    infos: { c1: { agent: "backend", model: { providerID: "prov", id: "mod", variant: "high" } } },
  })
  const { registry } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => clock })

  await nudge.tick()

  expect(calls.status).toBe(1)
  expect(calls.get).toEqual([{ path: { id: "c1" } }])
  expect(calls.promptAsync).toHaveLength(1)
  expect(calls.promptAsync[0]).toEqual({
    path: { id: "c1" },
    body: {
      parts: [{ type: "text", text: DEFAULT_NUDGE_PROMPT }],
      agent: "backend",
      model: { providerID: "prov", modelID: "mod" },
      variant: "high",
    },
  })
})

test("a busy child in the status map is never nudged", async () => {
  const { client, calls } = fakeClient({ statuses: { c1: { type: "busy" } } })
  const { registry } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.status).toBe(1)
  expect(calls.promptAsync).toHaveLength(0)
})

test("an idle child in the status map is marked done and never nudged", async () => {
  const { client, calls } = fakeClient({ statuses: { c1: { type: "idle" } } })
  const { registry, events } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.promptAsync).toHaveLength(0)
  expect(events).toEqual([{ type: "session.idle", properties: { sessionID: "c1" } }])
})

test("a child with an in-flight tool call is never nudged", async () => {
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry } = fakeRegistry([staleItem("c1", { activity: "tool" })])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.promptAsync).toHaveLength(0)
  // The idle-only pre-filter means the SDK is not even consulted.
  expect(calls.status).toBe(0)
})

test("done and error records are never nudged", async () => {
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry } = fakeRegistry([
    staleItem("done-child", { status: "done" }),
    staleItem("error-child", { status: "error" }),
  ])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.promptAsync).toHaveLength(0)
  expect(calls.status).toBe(0)
})

test("a session without a parent is never nudged", async () => {
  const { client, calls } = fakeClient({ statuses: {} })
  const item = staleItem("root")
  delete item.parentID
  const { registry } = fakeRegistry([item])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.promptAsync).toHaveLength(0)
  expect(calls.status).toBe(0)
})

test("attempts stop at NUDGE_MAX and notify fires exactly once", async () => {
  let clock = 1_000_000
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry, events } = fakeRegistry([staleItem("c1")])
  const notices = []
  const nudge = createSubagentNudge({
    client,
    registry,
    now: () => clock,
    notify: (message) => notices.push(message),
  })

  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(1)

  clock += 5000
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(2)

  clock += 5000
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(2)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain("giving up")
  expect(events).toEqual([{ type: "session.error", properties: { sessionID: "c1" } }])

  // A later tick neither nudges nor notifies again.
  clock += 5000
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(2)
  expect(notices).toHaveLength(1)
})

test("backoff prevents an immediate second nudge", async () => {
  let clock = 1_000_000
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry } = fakeRegistry([agingItem("c1", 0)])
  // Jitter fixed at its neutral midpoint so the thresholds are exact.
  const nudge = createSubagentNudge({ client, registry, now: () => clock, random: () => 0.5 })

  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(1)

  // Same instant: no backoff has elapsed.
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(1)

  // Attempt 1 requires the doubled backoff (1s * 2^1 = 2s); half of it is not
  // enough.
  clock += 1000
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(1)

  // Past the doubled backoff: the second nudge is allowed.
  clock += 2000
  await nudge.tick()
  expect(calls.promptAsync).toHaveLength(2)
})

test("a child younger than the staleness age is not nudged", async () => {
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry } = fakeRegistry([staleItem("c1", { sinceLastProgressMs: 100 })])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.status).toBe(1)
  expect(calls.promptAsync).toHaveLength(0)
})

test("a missing session.status does nothing and never throws", async () => {
  const { registry } = fakeRegistry([staleItem("c1")])
  const client = { session: { promptAsync: async () => ({ data: undefined }) } }
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await expect(nudge.tick()).resolves.toBeUndefined()
  await expect(nudge.tick()).resolves.toBeUndefined()
})

test("a rejecting promptAsync does not throw out of the tick", async () => {
  const { client, calls } = fakeClient({ statuses: {}, promptThrows: true })
  const { registry } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await expect(nudge.tick()).resolves.toBeUndefined()
  expect(calls.promptAsync).toHaveLength(1)
})

test("a failing session.get still sends the prompt without a target", async () => {
  const { client, calls } = fakeClient({ statuses: {}, getThrows: true })
  const { registry } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(calls.promptAsync).toHaveLength(1)
  expect(calls.promptAsync[0].body).toEqual({ parts: [{ type: "text", text: DEFAULT_NUDGE_PROMPT }] })
})

test("a failing session.status does not throw out of the tick", async () => {
  const { client, calls } = fakeClient({ statuses: {}, statusThrows: true })
  const { registry } = fakeRegistry([staleItem("c1")])
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await expect(nudge.tick()).resolves.toBeUndefined()
  expect(calls.promptAsync).toHaveLength(0)
})

test("hydrates an empty registry once (restart recovery)", async () => {
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry, state } = fakeRegistry([])
  state.afterHydrate = [staleItem("c1")]
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()
  expect(state.hydrateCalls).toBe(1)
  expect(calls.promptAsync).toHaveLength(1)

  // The registry is populated now, so later ticks skip hydration.
  await nudge.tick()
  expect(state.hydrateCalls).toBe(1)
})

test("at most MAX_NUDGES_PER_TICK children are nudged per tick", async () => {
  const ids = ["c1", "c2", "c3", "c4", "c5"]
  const { client, calls } = fakeClient({ statuses: {} })
  const { registry } = fakeRegistry(ids.map((id) => staleItem(id)))
  const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

  await nudge.tick()

  expect(MAX_NUDGES_PER_TICK).toBe(3)
  expect(calls.promptAsync).toHaveLength(3)
  expect(calls.promptAsync.map((call) => call.path.id)).toEqual(["c1", "c2", "c3"])
})

test("dispose clears the interval handle and stops the timer", () => {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let handle
  const cleared = []
  globalThis.setInterval = (fn, ms) => {
    handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true } }
    return handle
  }
  globalThis.clearInterval = (h) => {
    cleared.push(h)
  }
  try {
    const { client } = fakeClient({ statuses: {} })
    const { registry } = fakeRegistry([staleItem("c1")])
    const nudge = createSubagentNudge({ client, registry, now: () => 1_000_000 })

    const started = nudge.start()
    expect(started).toBe(handle)
    expect(handle.ms).toBe(60000)
    expect(handle.unrefCalled).toBe(true)
    // start() is idempotent while running.
    expect(nudge.start()).toBe(handle)

    nudge.dispose()
    expect(cleared).toEqual([handle])

    nudge.dispose()
    expect(cleared).toEqual([handle])
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})
test("start() installs no timer when the registry is missing", () => {
  const realSetInterval = globalThis.setInterval
  let installed = 0
  globalThis.setInterval = () => {
    installed += 1
    return { unref() {} }
  }
  try {
    const { client } = fakeClient({ statuses: {} })
    const nudge = createSubagentNudge({ client, now: () => 1_000_000 })

    expect(nudge.start()).toBeUndefined()
    expect(installed).toBe(0)
  } finally {
    globalThis.setInterval = realSetInterval
  }
})

test("a real registry keeps a restart orphan classifiable through hydrate", async () => {
  // Integration proof that reconciliation preserves the orphan signal: an orphan
  // absent from `session.status` is left in the derived `dead` tier instead of
  // being folded into `done`, so this job can still act on it. The child is
  // known only from `session.list` (in-memory state was lost) — the restart case.
  const child = {
    id: "child-1",
    parentID: "parent-1",
    title: "child-1",
    time: { created: 1_000_000, updated: 1_000_000 },
  }
  const calls = { promptAsync: [] }
  const client = {
    session: {
      list: async () => ({ data: [child] }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: child }),
      promptAsync: async (input) => {
        calls.promptAsync.push(input)
        return { data: undefined }
      },
    },
  }
  const clock = 1_000_000 + 600_000
  const { createSubagentStatus } = await import("./subagent-status.js")
  const status = createSubagentStatus({ client, now: () => clock, directory: "/tmp" })
  try {
    const nudge = createSubagentNudge({ client, registry: status.registry, now: () => clock })

    await nudge.tick()

    expect(calls.promptAsync).toHaveLength(1)
    expect(calls.promptAsync[0].path.id).toBe("child-1")
  } finally {
    status.dispose()
  }
})

test("the default reconcile leaves an absent orphan derived-dead, not done", async () => {
  // No opt-out is used any more: reconcile itself must not materialize `done`
  // from absence. This is the behaviour the nudge job depends on.
  const child = {
    id: "child-1",
    parentID: "parent-1",
    title: "child-1",
    time: { created: 1_000_000, updated: 1_000_000 },
  }
  const client = {
    session: {
      list: async () => ({ data: [child] }),
      status: async () => ({ data: {} }),
    },
  }
  const clock = 1_000_000 + 1_200_000 // past the default 10-minute dead threshold
  const { createSubagentStatus } = await import("./subagent-status.js")
  const status = createSubagentStatus({ client, now: () => clock, directory: "/tmp" })
  try {
    await status.registry.hydrate()

    expect(status.registry.get("child-1").status).toBe("dead")
  } finally {
    status.dispose()
  }
})
