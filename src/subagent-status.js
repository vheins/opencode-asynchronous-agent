/**
 * Opt-in `subagent_status` custom tool for the OpenCode V1 plugin entrypoint.
 *
 * OpenCode has no built-in way for an agent to poll the liveness of the
 * background subagent sessions it spawned: the model is push-only (the parent
 * is notified when a child finishes). This module keeps an in-memory registry
 * of child sessions, updated from the plugin `event` hook, and exposes a
 * `subagent_status` tool that reports each tracked child as
 * `running` / `stale` / `dead` / `done` / `error`.
 *
 * Liveness uses two clocks. `lastProgressAt` advances only on STRONG evidence
 * that the child did work (message/todo updates, a `busy`/`retry` status);
 * `lastEventAt` advances on any event and is bookkeeping only. Staleness is
 * derived from the progress clock alone, so a chatty but idle child cannot
 * masquerade as running.
 *
 * An in-flight TOOL CALL counts as proof of life even when it emits no session
 * events: a child running `bash` (build, install, test suite) can legitimately
 * sit for many minutes. Each tracked `tool` part is recorded by call id and
 * only stops counting once it has run past
 * `OPENCODE_SUBAGENT_TOOL_GRACE_MS` (default 30 min).
 *
 * `stale` and `dead` are DERIVED states: they are never written into
 * `record.status`, which stays the lifecycle base (`running` / `done` /
 * `error`). A child that emits progress after finishing therefore returns to
 * `running` cleanly.
 *
 * Reconciliation treats ABSENCE from `session.status()` as unknown, not success:
 * the SDK map carries only `busy`/`retry` (and occasionally `idle`), so a
 * stopped child is normally absent whether it finished or wedged. Such a child
 * stays derived `stale` then `dead`; `done` is written only on a positive signal
 * (a reported `idle`, or a transcript-confirmed final answer), keeping the
 * `dead -> subagent_cancel` remediation and orphan-nudge signal reachable.
 *
 * The tool is opt-in: set `OPENCODE_SUBAGENT_STATUS=1` (or `true` / `on` /
 * `yes`). Thresholds are configurable via `OPENCODE_SUBAGENT_STALE_MS`
 * (default 120000 ms), `OPENCODE_SUBAGENT_DEAD_MS` (default 600000 ms), and
 * `OPENCODE_SUBAGENT_TOOL_GRACE_MS` (default 1800000 ms).
 *
 * The registry and the pure classification helper are independent of the
 * OpenCode runtime so they can be unit-tested directly.
 *
 * @module subagent-status
 */
import { STATUS_TOOL_ID, createStatusTool } from "./subagent-status-tool.js"
import {
  DEFAULT_RECONCILE_MS,
  buildItem,
  classifyStatus,
  countByStatus,
  deadThresholdMs,
  doneRetentionMs,
  isSubagentSession,
  pruneActiveTools,
  staleThresholdMs,
  toolGraceThresholdMs,
} from "./subagent-liveness.js"
import { statusRank } from "./subagent-format.js"
import { createDeadConfirmer } from "./subagent-dead-check.js"
import { createEventHandlers } from "./subagent-status-events.js"

// The tool id and the model-facing tool shell live in `./subagent-status-tool.js`.
export { STATUS_TOOL_ID }

// The pure liveness math lives in `./subagent-liveness.js` so the classification
// rules stay unit-testable without a runtime.
export {
  DEFAULT_DEAD_MS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_STALE_MS,
  DEFAULT_TOOL_GRACE_MS,
  DONE_RETENTION_MS,
  activityOf,
  classifyStatus,
  contextUsedOf,
  deadThresholdMs,
  doneRetentionMs,
  formatDuration,
  isSubagentSession,
  normalizeTokens,
  progressEvidenceAt,
  staleThresholdMs,
  summarizeStats,
  toolGraceThresholdMs,
} from "./subagent-liveness.js"

// The opt-in env gate lives in the dependency-free utils module so the core
// hook can read it without loading this tool-registering module. Re-exported
// here to keep this module's public surface stable (tests import it from here).
export { statusEnabled } from "./subagent-utils.js"

/**
 * Build the status feature: the `subagent_status` tool and its registry.
 *
 * @param {object} [options] clock, thresholds, SDK client, reconcile cadence.
 * @returns {object}
 */
export function createSubagentStatus(options = {}) {
  const now = options.now ?? (() => Date.now())
  const threshold = options.threshold ?? staleThresholdMs
  const deadThreshold = options.deadThreshold ?? deadThresholdMs
  const toolGrace = options.toolGrace ?? toolGraceThresholdMs
  const retention = options.retention ?? doneRetentionMs
  const reconcileInterval = Number.isFinite(options.reconcileIntervalMs)
    ? Math.max(0, options.reconcileIntervalMs)
    : DEFAULT_RECONCILE_MS
  const client = options.client
  const records = new Map()

  // Throttle SDK reconciliation so `report()` can call it on every invocation
  // without issuing an SDK round-trip each time. Tracked per registry instance
  // (production has exactly one; per-instance keeps tests isolated).
  let lastReconcileAt = Number.NEGATIVE_INFINITY
  /** In-flight reconcile shared by concurrent callers, so only one pass runs. */
  let reconcileInFlight

  /**
   * Bounded confirm-dead probe: resolves a derived-dead child against its
   * transcript at most once, materializing `done`/`error` on a real signal.
   */
  const deadConfirmer = createDeadConfirmer({ client, markTerminal })

  /**
   * Advance the progress clock (strong evidence the child did work) and revive a
   * terminal record. Reviving clears `doneAt` so the record is genuinely live
   * again instead of a `done` record with stale bookkeeping.
   *
   * Writes are monotonic: a slower overlapping reconcile pass must never move
   * the progress clock backwards.
   */
  function touchProgress(record, current) {
    record.lastProgressAt = Math.max(record.lastProgressAt ?? current, current)
    record.lastEventAt = Math.max(record.lastEventAt ?? current, current)
    if (record.status === "done" || record.status === "error") {
      record.status = "running"
      record.doneAt = undefined
      // A revived child starts a fresh life: its cached confirm-dead verdict no
      // longer describes it.
      deadConfirmer.forget(record.sessionID)
    }
  }

  /** Advance only the bookkeeping clock; never proves the child is working. */
  function touchEvent(record, current) {
    record.lastEventAt = Math.max(record.lastEventAt ?? current, current)
  }

  /** Mark a record terminal, stamp the transition time, and drop in-flight tool
   * state.
   *
   * Clearing `activeTools` is required: a leftover tool entry would make
   * `activityOf` report `tool` and `classifyStatus` pin the record at `running`
   * after it was revived, which is the zombie bug this module exists to remove.
   */
  function markTerminal(record, status, current) {
    record.status = status
    record.doneAt = Math.max(record.doneAt ?? current, current)
    record.lastEventAt = Math.max(record.lastEventAt ?? current, current)
    if (record.activeTools && typeof record.activeTools.clear === "function") record.activeTools.clear()
    deadConfirmer.forget(record.sessionID)
  }

  /**
   * Fold a `tool` part into the active-call tracker. A running/pending call
   * keeps its original start (never overwritten), a completed/error call is
   * removed, and an unknown state leaves the tracker alone.
   */
  function applyToolPart(record, part, current) {
    const key = part?.callID ?? part?.id
    const state = part?.state
    const status = state?.status
    const startedAt = Number.isFinite(state?.time?.start) ? state.time.start : current
    const tool = typeof part?.tool === "string" && part.tool ? part.tool : "tool"
    const stats = record.stats
    // A tool part that never emitted a terminal state must not pin the record
    // forever; prune entries older than the grace window before tracking this one.
    pruneActiveTools(record, current, toolGrace())
    // A tool part re-emits on every state change, so count each call once by its
    // call id. Count on FIRST SIGHT regardless of status: a part that first
    // appears as `completed` (plugin loaded mid-turn, or a fast tool) still ran.
    if (!key || !stats.seenToolCalls.has(key)) {
      if (key) stats.seenToolCalls.add(key)
      stats.toolCalls += 1
      stats.toolCounts[tool] = (stats.toolCounts[tool] ?? 0) + 1
    }
    if (status === "running" || status === "pending") {
      if (key && !record.activeTools.has(key)) {
        record.activeTools.set(key, { tool, startedAt })
      }
      stats.lastTool = { tool, status: "running", at: current }
      record.lastActivity = `tool:${tool}`
      record.lastActivityAt = current
      touchProgress(record, current)
      return
    }
    if (status === "completed" || status === "error") {
      if (key) record.activeTools.delete(key)
      // Count an error once per call id (the state transition re-emits).
      if (status === "error" && (!key || !stats.erroredCalls.has(key))) {
        if (key) stats.erroredCalls.add(key)
        stats.toolErrors += 1
      }
      stats.lastTool = { tool, status, at: current }
      record.lastActivity = `tool:${tool}`
      record.lastActivityAt = current
      touchProgress(record, current)
      return
    }
    if (typeof part?.text === "string" && part.text.length > 0) touchProgress(record, current)
  }

  /**
   * Run one reconcile pass, or join the pass already running.
   *
   * Sharing the promise guarantees concurrent `report()` calls cannot interleave
   * two passes; a slower older pass would otherwise write a stale `current` into
   * a shared record after a newer pass advanced it.
   *
   * @returns {Promise<void>}
   */
  function requestReconcile() {
    if (reconcileInFlight) return reconcileInFlight
    const pass = reconcile().finally(() => {
      if (reconcileInFlight === pass) reconcileInFlight = undefined
    })
    reconcileInFlight = pass
    return pass
  }

  /** Drop finished/stale/dead records that have aged past the retention window. */
  function sweep(current) {
    const staleMs = threshold()
    const deadMs = deadThreshold()
    const graceMs = toolGrace()
    const keepMs = retention()
    for (const [id, record] of records) {
      pruneActiveTools(record, current, graceMs)
      const status = classifyStatus(record, current, staleMs, deadMs, graceMs)
      // `unknown` is a record with no usable clock (see `classifyStatus`). It has
      // no retention horizon, so it is swept immediately instead of being kept
      // forever; the same non-finite-age guard covers any terminal record whose
      // progress clock was never stamped.
      const evictable = status === "done" || status === "error" || status === "stale" || status === "dead" || status === "unknown"
      const age = current - record.lastProgressAt
      if (evictable && (!Number.isFinite(age) || age > keepMs)) {
        records.delete(id)
        deadConfirmer.forget(id)
      }
    }
  }

  /** Insert a new child record, or refresh identity fields on an existing one. */
  function upsert(info, current, { progressAt } = {}) {
    const existing = records.get(info.id)
    if (existing) {
      refreshIdentity(existing, info)
      pruneActiveTools(existing, current, toolGrace())
      return
    }
    // New sessions genuinely just appeared, so stamping `current` is correct
    // here. The reconciliation path passes the session's own timestamps instead.
    const stamp = Number.isFinite(progressAt) ? progressAt : current
    records.set(info.id, {
      sessionID: info.id,
      parentID: info.parentID,
      title: typeof info.title === "string" && info.title ? info.title : "Untitled subagent",
      slug: typeof info.slug === "string" && info.slug ? info.slug : undefined,
      agent: typeof info.agent === "string" && info.agent ? info.agent : undefined,
      status: "running",
      startedAt: Number.isFinite(info.time?.created) ? info.time.created : stamp,
      lastEventAt: stamp,
      lastProgressAt: stamp,
      lastStatusType: undefined,
      doneAt: undefined,
      activeTools: new Map(),
      // Todo state cached from `todo.updated` so reports show `n/m` free.
      todos: null,
      // Counters accumulated from events, so listing N children stays one read.
      stats: newStats(),
      lastActivity: undefined,
      lastActivityAt: undefined,
    })
  }

  /** Fresh event-derived statistics accumulator. */
  function newStats() {
    return {
      toolCalls: 0,
      toolErrors: 0,
      toolCounts: {},
      lastTool: undefined,
      seenToolCalls: new Set(),
      erroredCalls: new Set(),
      tokens: undefined,
      model: undefined,
      contextLimit: undefined,
    }
  }

  /** Refresh identity fields of a tracked record without touching its clocks. */
  function refreshIdentity(record, info) {
    if (typeof info.title === "string" && info.title) record.title = info.title
    if (typeof info.parentID === "string" && info.parentID) record.parentID = info.parentID
    if (typeof info.slug === "string" && info.slug) record.slug = info.slug
    if (typeof info.agent === "string" && info.agent) record.agent = info.agent
  }

  /**
   * Progress stamp for a record inserted from session info rather than from live
   * activity: the session's own `updated`/`created` time, falling back to
   * `current`. Never `current` when the info carries a time, or an hours-old
   * session would be reported as freshly running.
   *
   * @param {object} info
   * @param {number} current
   * @returns {number}
   */
  function sessionProgressAt(info, current) {
    const at = info?.time?.updated ?? info?.time?.created
    return Number.isFinite(at) ? at : current
  }

  /**
   * Merge SDK state into the registry. `session.list` adds sessions the event
   * stream missed; `session.status` is the arbiter for lifecycle state.
   * Missing or failing SDK methods are a silent no-op.
   *
   * Absence from the status map is NOT success. The SDK map carries only
   * `busy`/`retry` (and occasionally `idle`), so a stopped child is normally
   * absent regardless of whether it finished or wedged. Reconciliation therefore
   * never materialises `done` from absence alone: the derived `stale`/`dead`
   * tier speaks instead, which is honest about not knowing the outcome. `done`
   * is written only on a positive signal — a reported `idle`, a final answer
   * confirmed by the transcript probe, or the event handlers.
   *
   * @returns {Promise<void>}
   */
  async function reconcile() {
    const api = client?.session
    if (!api) return
    const current = now()

    if (typeof api.list === "function") {
      try {
        const response = await api.list()
        const sessions = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
        for (const info of sessions) {
          if (!isSubagentSession(info)) continue
          const existing = records.get(info.id)
          if (existing) {
            refreshIdentity(existing, info)
            pruneActiveTools(existing, current, toolGrace())
            continue
          }
          // NEVER stamp `now()` here: the session may be hours old, and a fresh
          // stamp would hide it from the stale/dead tiers for a full threshold.
          const seen = info.time?.updated ?? info.time?.created ?? current
          upsert(info, current, { progressAt: seen })
        }
      } catch {
        // Session listing unavailable: reporting still works from events only.
      }
    }

    if (typeof api.status !== "function") return
    let map
    try {
      const statuses = await api.status()
      map = statuses?.data ?? statuses
    } catch {
      return
    }
    if (!map || typeof map !== "object") return

    const staleMs = threshold()
    const deadMs = deadThreshold()
    const graceMs = toolGrace()
    for (const [id, status] of Object.entries(map)) {
      const record = records.get(id)
      if (!record) continue
      const type = status?.type
      record.lastStatusType = type
      if (type === "idle") {
        markTerminal(record, "done", current)
      } else if (type === "busy" || type === "retry") {
        // Proof of life right now: the SDK says the child is actively working.
        touchProgress(record, current)
      }
    }

    // A child absent from the status map past the dead threshold is left in the
    // derived `dead` tier. Confirm each one once: a recorded final answer turns
    // the ambiguity into a real `done`/`error`.
    const candidates = []
    for (const record of records.values()) {
      if (record.status !== "running") continue
      if (Object.prototype.hasOwnProperty.call(map, record.sessionID)) continue
      if (classifyStatus(record, current, staleMs, deadMs, graceMs) !== "dead") continue
      candidates.push(record)
    }
    if (candidates.length > 0) await deadConfirmer.confirm(candidates, current)
  }

  /**
   * Historical alias for an initial reconcile.
   *
   * @returns {Promise<void>}
   */
  async function hydrate() {
    lastReconcileAt = Number.NEGATIVE_INFINITY
    await requestReconcile()
  }

  const handlers = createEventHandlers({
    get: (id) => records.get(id),
    upsert,
    refreshIdentity,
    touchProgress,
    touchEvent,
    markTerminal,
    applyToolPart,
    sessionProgressAt,
    remove: (id) => records.delete(id),
  })

  /** Feed one plugin event into the registry. */
  function ingest(event) {
    if (!event || typeof event !== "object") return
    const handler = handlers.get(event.type)
    if (!handler) return
    handler(event.properties ?? {}, now())
  }

  /** Build the filtered, sorted, classified snapshot. */
  function snapshot(filter = {}) {
    const current = now()
    const staleMs = threshold()
    const deadMs = deadThreshold()
    const graceMs = toolGrace()
    const parent = typeof filter?.parent === "string" && filter.parent ? filter.parent : undefined
    const wanted = typeof filter?.status === "string" && filter.status ? filter.status : undefined
    return [...records.values()]
      .map((record) => buildItem(record, current, staleMs, deadMs, graceMs))
      .filter((item) => (parent ? item.parentID === parent : true))
      .filter((item) => (wanted ? item.status === wanted : true))
      .sort(
        (a, b) =>
          statusRank(a.status) - statusRank(b.status) ||
          a.startedAt - b.startedAt ||
          a.sessionID.localeCompare(b.sessionID),
      )
  }

  /** Classified snapshot item for one session, or `undefined` when untracked. */
  function get(sessionID) {
    const record = records.get(sessionID)
    if (!record) return undefined
    return buildItem(record, now(), threshold(), deadThreshold(), toolGrace())
  }

  /** Classified status string for one session, or `undefined` when untracked. */
  function classify(sessionID) {
    const record = records.get(sessionID)
    if (!record) return undefined
    return classifyStatus(record, now(), threshold(), deadThreshold(), toolGrace())
  }

  /** Produce the full report, reconciling with the SDK on a throttled cadence. */
  async function report(filter = {}) {
    const start = now()
    sweep(start)
    if (start - lastReconcileAt >= reconcileInterval) {
      // Throttle from the START of the attempt, and share the in-flight pass so
      // two overlapping reports cannot run two reconciles against one registry.
      lastReconcileAt = Number.isFinite(lastReconcileAt) ? Math.max(lastReconcileAt, start) : start
      await requestReconcile()
    }
    sweep(now())
    const items = snapshot(filter)
    return {
      items,
      counts: countByStatus(items),
      staleThresholdMs: threshold(),
      deadThresholdMs: deadThreshold(),
      toolGraceMs: toolGrace(),
    }
  }

  return {
    tool: { [STATUS_TOOL_ID]: createStatusTool(report) },
    event: async (input) => {
      ingest(input?.event)
    },
    dispose: async () => {
      records.clear()
      deadConfirmer.reset()
    },
    registry: { ingest, report, snapshot, reconcile: requestReconcile, hydrate, get, classify },
  }
}
