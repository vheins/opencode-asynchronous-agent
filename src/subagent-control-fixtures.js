/**
 * Shared fakes for the subagent control-tool tests.
 *
 * Extracted so the control tests can split along behaviour boundaries
 * (children / result / send / watch / helpers) without each file re-declaring
 * the same SDK stub. Nothing here asserts; it only builds test doubles.
 *
 * @module subagent-control-fixtures
 */

/** Fake SDK client capturing calls and returning canned payloads. */
export function fakeClient(overrides = {}) {
  const calls = { children: [], messages: [], status: 0, abort: [], promptAsync: [], get: [] }
  const client = {
    session: {
      get: async (input) => {
        calls.get.push(input)
        return { data: overrides.get }
      },
      children: async (input) => {
        calls.children.push(input)
        return { data: overrides.children ?? [] }
      },
      messages: async (input) => {
        calls.messages.push(input)
        return { data: overrides.messages ?? [] }
      },
      status: async () => {
        calls.status += 1
        return { data: overrides.status ?? {} }
      },
      abort: async (input) => {
        calls.abort.push(input)
        return { data: overrides.abort }
      },
      promptAsync: async (input) => {
        calls.promptAsync.push(input)
        return { data: undefined }
      },
    },
  }
  return { client, calls }
}

/**
 * Stub registry exposing only what the control tools read. `status` is the
 * classified status reported by `get`.
 */
export function stubRegistry({ status = "running", item = {}, writes = [], items = [] } = {}) {
  const state = { status, item, items }
  return {
    state,
    writes,
    get(sessionID) {
      if (state.missing) return undefined
      return {
        sessionID,
        status: state.status,
        stale: state.status === "stale",
        dead: state.status === "dead",
        activity: state.item.activity ?? "idle",
        activeTool: state.item.activeTool ?? null,
        sinceLastProgressMs: state.item.sinceLastProgressMs ?? 0,
        todo: state.item.todo ?? null,
        agent: state.item.agent,
        slug: state.item.slug,
      }
    },
    classify() {
      return state.status
    },
    snapshot() {
      return state.items
    },
  }
}

/** A registry snapshot item with only the fields the renderer reads. */
export function regItem(overrides = {}) {
  return {
    sessionID: "ses_child",
    parentID: "ses_parent",
    title: "Child",
    agent: "backend",
    status: "running",
    activity: "idle",
    activeTool: null,
    todo: null,
    startedAt: 1000,
    elapsedMs: 60000,
    stale: false,
    dead: false,
    sinceLastProgressMs: 0,
    sinceLastEventMs: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCounts: {},
    ...overrides,
  }
}

/** Drive a fake clock: each `sleep(ms)` advances it and advances a status list. */
export function watchHarness(registry, { statuses }) {
  let clock = 0
  let index = 0
  const sleep = async (ms) => {
    clock += ms
    // Mutate the stub registry's status on the scheduled tick.
    if (index < statuses.length) {
      registry.state.status = statuses[index]
      index += 1
    }
  }
  return { now: () => clock, sleep }
}
