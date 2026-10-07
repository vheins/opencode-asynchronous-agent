/**
 * Opt-in `subagent_status` custom tool for the OpenCode V1 plugin entrypoint.
 *
 * OpenCode has no built-in way for an agent to poll the liveness of the
 * background subagent sessions it spawned: the model is push-only (the parent
 * is notified when a child finishes). This module keeps an in-memory registry
 * of child sessions, updated from the plugin `event` hook, and exposes a
 * `subagent_status` tool that reports each tracked child as
 * `running` / `done` / `error` / `stale`.
 *
 * The tool is opt-in: set `OPENCODE_SUBAGENT_STATUS=1` (or `true` / `on` /
 * `yes`). The staleness threshold is configurable via
 * `OPENCODE_SUBAGENT_STALE_MS` (default 120000 ms).
 *
 * The registry and the pure classification helper are independent of the
 * OpenCode runtime so they can be unit-tested directly.
 *
 * @module subagent-status
 */

import { tool } from "@opencode-ai/plugin"

/** Custom tool id exposed to the model. */
export const STATUS_TOOL_ID = "subagent_status"

/** Default age (ms) after which a still-running child is reported as stale. */
export const DEFAULT_STALE_MS = 120000

/** How long (ms) a finished child stays in the registry before being pruned. */
export const DONE_RETENTION_MS = 3600000

/** Values accepted as "enabled" for the opt-in env gate. */
const TRUTHY = new Set(["1", "true", "yes", "on", "y"])

/**
 * Whether the opt-in status tool is enabled via `OPENCODE_SUBAGENT_STATUS`.
 *
 * @returns {boolean}
 */
export function statusEnabled() {
  return TRUTHY.has(String(process.env.OPENCODE_SUBAGENT_STATUS ?? "").trim().toLowerCase())
}

/**
 * Configured staleness threshold in milliseconds. Falls back to
 * {@link DEFAULT_STALE_MS} when unset or not a positive number.
 *
 * @returns {number}
 */
export function staleThresholdMs() {
  const raw = Number(String(process.env.OPENCODE_SUBAGENT_STALE_MS ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_MS
}

/**
 * Whether a session object represents a child (subagent) session.
 *
 * @param {unknown} info
 * @returns {boolean}
 */
export function isSubagentSession(info) {
  return Boolean(info) && typeof info === "object" && typeof info.parentID === "string" && info.parentID.length > 0
}

/**
 * Classify a tracked record into its reported status.
 *
 * `stale` is derived: a record that is still running but whose last event is
 * older than `threshold` is stale. Terminal `done` / `error` states always win.
 *
 * @param {{ status: string, lastEventAt: number }} record
 * @param {number} now
 * @param {number} threshold
 * @returns {"running" | "done" | "error" | "stale"}
 */
export function classifyStatus(record, now, threshold) {
  if (record.status === "error") return "error"
  if (record.status === "done") return "done"
  if (now - record.lastEventAt > threshold) return "stale"
  return "running"
}

/**
 * Render a millisecond duration as a short human-readable label.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : `${minutes}m ${seconds % 60}s`
}

/** Sort priority for reported statuses (most attention-worthy first). */
const STATUS_RANK = { stale: 0, running: 1, error: 2, done: 3 }

/** Build the plain-text body of the tool result. */
function formatReport(items, summary, threshold) {
  if (items.length === 0) {
    return `No background subagents tracked (stale threshold ${formatDuration(threshold)}).`
  }
  const header =
    `${summary.total} subagent(s): ${summary.running} running, ${summary.done} done, ` +
    `${summary.error} error, ${summary.stale} stale (stale threshold ${formatDuration(threshold)})`
  const lines = items.map((item) =>
    [
      `- [${item.status}] ${item.sessionID}`,
      `title=${JSON.stringify(item.title)}`,
      `agent=${item.agent ?? "?"}`,
      `parent=${item.parentID}`,
      `elapsed=${formatDuration(item.elapsedMs)}`,
      `since-event=${formatDuration(item.sinceLastEventMs)}`,
    ].join(" · "),
  )
  return [header, ...lines].join("\n")
}

/**
 * Create the status feature: an in-memory registry, the `subagent_status` tool,
 * and the `event` hook that feeds the registry.
 *
 * @param {{
 *   now?: () => number,
 *   threshold?: () => number,
 *   client?: { session?: { list?: Function, status?: Function } },
 *   directory?: string,
 * }} [options]
 * @returns {{
 *   tool: Record<string, unknown>,
 *   event: (input: { event: unknown }) => Promise<void>,
 *   dispose: () => Promise<void>,
 *   registry: {
 *     ingest: (event: unknown) => void,
 *     report: (filter?: { parent?: string, status?: string }) => Promise<object>,
 *     snapshot: (filter?: { parent?: string, status?: string }) => object[],
 *     hydrate: () => Promise<void>,
 *   },
 * }}
 */
export function createSubagentStatus(options = {}) {
  const now = options.now ?? (() => Date.now())
  const threshold = options.threshold ?? staleThresholdMs
  const client = options.client
  const records = new Map()

  /** Drop finished records that have aged past the retention window. */
  function sweep(current) {
    for (const [id, record] of records) {
      const status = classifyStatus(record, current, threshold())
      if ((status === "done" || status === "error") && current - record.lastEventAt > DONE_RETENTION_MS) {
        records.delete(id)
      }
    }
  }

  /** Insert or refresh a child session record. */
  function upsert(info, current) {
    const existing = records.get(info.id)
    if (existing) {
      if (typeof info.title === "string" && info.title) existing.title = info.title
      existing.lastEventAt = current
      return
    }
    records.set(info.id, {
      sessionID: info.id,
      parentID: info.parentID,
      title: typeof info.title === "string" && info.title ? info.title : "Untitled subagent",
      agent: undefined,
      status: "running",
      startedAt: Number.isFinite(info.time?.created) ? info.time.created : current,
      lastEventAt: current,
    })
  }

  /** Map-based event dispatch (no switch/if-chain). */
  const handlers = new Map([
    ["session.created", (props, current) => {
      if (isSubagentSession(props.info)) upsert(props.info, current)
    }],
    ["session.updated", (props, current) => {
      if (isSubagentSession(props.info)) upsert(props.info, current)
    }],
    ["session.status", (props, current) => {
      const record = records.get(props.sessionID)
      if (!record) return
      record.lastEventAt = current
      const type = props.status?.type
      if (type === "idle") record.status = "done"
      else if (type === "busy" || type === "retry") record.status = "running"
    }],
    ["session.idle", (props, current) => {
      const record = records.get(props.sessionID)
      if (!record) return
      record.status = "done"
      record.lastEventAt = current
    }],
    ["session.error", (props, current) => {
      const record = records.get(props.sessionID)
      if (!record) return
      record.status = "error"
      record.lastEventAt = current
    }],
    ["session.deleted", (props) => {
      const id = props.info?.id
      if (id) records.delete(id)
    }],
    ["message.updated", (props, current) => {
      const record = records.get(props.info?.sessionID)
      if (!record) return
      record.lastEventAt = current
      if (props.info?.role === "assistant" && typeof props.info.agent === "string" && props.info.agent) {
        record.agent = props.info.agent
      }
    }],
    ["message.part.updated", (props, current) => {
      const record = records.get(props.part?.sessionID)
      if (record) record.lastEventAt = current
    }],
  ])

  /** Feed one plugin event into the registry. */
  function ingest(event) {
    if (!event || typeof event !== "object") return
    const handler = handlers.get(event.type)
    if (!handler) return
    handler(event.properties ?? {}, now())
  }

  /** Best-effort hydration from the SDK when the registry is still empty. */
  async function hydrate() {
    if (typeof client?.session?.list !== "function") return
    try {
      const response = await client.session.list()
      const sessions = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
      const current = now()
      for (const info of sessions) {
        if (isSubagentSession(info) && !records.has(info.id)) upsert(info, current)
      }
      if (typeof client.session.status === "function") {
        const statuses = await client.session.status()
        const map = statuses?.data ?? statuses
        if (map && typeof map === "object") {
          for (const [id, status] of Object.entries(map)) {
            const record = records.get(id)
            if (record && status?.type === "idle") record.status = "done"
          }
        }
      }
    } catch {
      // SDK method unavailable or failed: reporting still works from events only.
    }
  }

  /** Build the filtered, sorted, classified snapshot. */
  function snapshot(filter = {}) {
    const current = now()
    const limit = threshold()
    const parent = typeof filter?.parent === "string" && filter.parent ? filter.parent : undefined
    const wanted = typeof filter?.status === "string" && filter.status ? filter.status : undefined
    return [...records.values()]
      .map((record) => {
        const status = classifyStatus(record, current, limit)
        return {
          sessionID: record.sessionID,
          parentID: record.parentID,
          title: record.title,
          agent: record.agent,
          status,
          stale: status === "stale",
          startedAt: record.startedAt,
          lastEventAt: record.lastEventAt,
          elapsedMs: Math.max(0, current - record.startedAt),
          sinceLastEventMs: Math.max(0, current - record.lastEventAt),
        }
      })
      .filter((item) => (parent ? item.parentID === parent : true))
      .filter((item) => (wanted ? item.status === wanted : true))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.startedAt - b.startedAt)
  }

  /** Aggregate counts over a snapshot. */
  function countByStatus(items) {
    return {
      total: items.length,
      running: items.filter((item) => item.status === "running").length,
      done: items.filter((item) => item.status === "done").length,
      error: items.filter((item) => item.status === "error").length,
      stale: items.filter((item) => item.status === "stale").length,
    }
  }

  /** Produce the full report, hydrating from the SDK when nothing is tracked. */
  async function report(filter = {}) {
    sweep(now())
    if (records.size === 0) await hydrate()
    sweep(now())
    const items = snapshot(filter)
    return { items, counts: countByStatus(items), staleThresholdMs: threshold() }
  }

  const statusTool = tool({
    description:
      "Report the status of background subagent sessions spawned by this session. " +
      "Each subagent is classified as running, done, error, or stale (still running " +
      "but with no event within the stale threshold). Returns parent linkage, elapsed " +
      "time, and time since the last event.",
    args: {
      parent: tool.schema
        .string()
        .optional()
        .describe("Only report subagents whose parent session id equals this value."),
      status: tool.schema
        .enum(["running", "done", "error", "stale"])
        .optional()
        .describe("Only report subagents currently in this status."),
    },
    async execute(args) {
      const { items, counts, staleThresholdMs: limit } = await report(args ?? {})
      return {
        title: `Subagents · ${counts.total} tracked`,
        output: formatReport(items, counts, limit),
        metadata: { subagents: items, counts, staleThresholdMs: limit },
      }
    },
  })

  return {
    tool: { [STATUS_TOOL_ID]: statusTool },
    event: async (input) => {
      ingest(input?.event)
    },
    dispose: async () => {
      records.clear()
    },
    registry: { ingest, report, snapshot, hydrate },
  }
}
