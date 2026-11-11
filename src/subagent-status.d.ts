/**
 * Type surface for {@link ./subagent-status.js}. The implementation is plain
 * runtime JavaScript (matching src/index.js, which tsc does not compile), so
 * this declaration lets the TypeScript unit test import it with full types.
 */

export const STATUS_TOOL_ID: string
export const DEFAULT_STALE_MS: number
export const DEFAULT_DEAD_MS: number
export const DEFAULT_TOOL_GRACE_MS: number
export const DONE_RETENTION_MS: number
export const DEFAULT_RECONCILE_MS: number

export type SubagentStatus = "running" | "stale" | "dead" | "done" | "error" | "unknown"
export type SubagentActivity = "tool" | "streaming" | "idle"
export type SubagentLifecycleStatus = "running" | "done" | "error"

export interface ActiveTool {
  tool: string
  startedAt: number
}

/** Token usage, mirroring the TUI's shape in src/model.ts `sessionMetrics`. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** Provider/model identity reported by an assistant message. */
export interface SubagentModel {
  providerID?: string
  modelID?: string
}

/** Todo progress derived from the newest `todowrite`/todo event. */
export interface TodoSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
  current?: string
}

/** Event-derived statistics accumulated without any extra SDK call. */
export interface SubagentStats {
  toolCalls: number
  toolErrors: number
  toolCounts: Record<string, number>
  lastTool?: { tool: string; status: string; at: number }
  tokens?: TokenUsage
  model?: SubagentModel
  contextLimit?: number
}

export interface SubagentRecord {
  sessionID: string
  parentID: string
  title: string
  slug?: string
  agent?: string
  status: SubagentLifecycleStatus
  startedAt: number
  lastEventAt: number
  lastProgressAt: number
  lastStatusType?: string
  doneAt?: number
  activeTools: Map<string, ActiveTool>
  todos: TodoSummary | null
  stats: SubagentStats
  lastActivity?: string
  lastActivityAt?: number
}

export interface SubagentReportItem {
  sessionID: string
  parentID: string
  title: string
  slug?: string
  agent?: string
  status: SubagentStatus
  stale: boolean
  dead: boolean
  activity: SubagentActivity
  activeTool: { tool: string; runningMs: number } | null
  lastStatusType?: string
  startedAt: number
  lastEventAt: number
  lastProgressAt: number
  doneAt?: number
  elapsedMs: number
  sinceLastEventMs: number
  sinceLastProgressMs: number
  model?: SubagentModel
  tokens?: TokenUsage
  contextLimit?: number
  contextUsed?: number
  contextPercent: number | null
  toolCalls: number
  toolErrors: number
  toolCounts: Record<string, number>
  lastTool?: { tool: string; status: string; at: number }
  todo: TodoSummary | null
  lastActivity?: string
  lastActivityAt?: number
  sinceLastActivityMs?: number
}

export interface SubagentCounts {
  total: number
  running: number
  done: number
  error: number
  stale: number
  dead: number
  working: number
}

export interface SubagentFilter {
  parent?: string
  status?: SubagentStatus
}

export interface SubagentStatusReport {
  items: SubagentReportItem[]
  counts: SubagentCounts
  staleThresholdMs: number
  deadThresholdMs: number
  toolGraceMs: number
}

export function statusEnabled(): boolean
export function staleThresholdMs(): number
export function deadThresholdMs(): number
export function toolGraceThresholdMs(): number
export function doneRetentionMs(): number
export function isSubagentSession(info: unknown): boolean
export function normalizeTokens(tokens: unknown): TokenUsage | undefined
export function contextUsedOf(tokens: TokenUsage | undefined): number | undefined
export function summarizeStats(
  record: { stats?: SubagentStats; lastActivity?: string; lastActivityAt?: number; todos?: TodoSummary | null },
  current?: number,
): {
  model: SubagentModel | undefined
  tokens: TokenUsage | undefined
  contextLimit: number | undefined
  contextUsed: number | undefined
  contextPercent: number | null
  toolCalls: number
  toolErrors: number
  toolCounts: Record<string, number>
  lastTool: { tool: string; status: string; at: number } | undefined
  todo: TodoSummary | null
  lastActivity: string | undefined
  lastActivityAt: number | undefined
  sinceLastActivityMs: number | undefined
}
export function progressEvidenceAt(record: Partial<SubagentRecord>): number
export function classifyStatus(
  record: {
    status: string
    lastProgressAt?: number
    startedAt?: number
    lastEventAt?: number
    activeTools?: Map<string, ActiveTool>
  },
  now: number,
  staleMs: number,
  deadMs?: number,
  toolGraceMs?: number,
): SubagentStatus
export function formatDuration(ms: number): string
export function activityOf(
  record: { status?: string; lastProgressAt: number; activeTools?: Map<string, ActiveTool> },
  current: number,
  staleMs: number,
): SubagentActivity
export function pruneActiveTools(
  record: { activeTools?: Map<string, ActiveTool> },
  current: number,
  toolGraceMs: number,
): void

/** A single record projected for reporting: derived status plus every counter. */
export function buildItem(
  record: Partial<SubagentRecord>,
  current: number,
  staleMs: number,
  deadMs: number,
  graceMs: number,
): SubagentReportItem

/** Per-status counts over a snapshot, plus the total and in-flight count. */
export function countByStatus(items: SubagentReportItem[]): SubagentCounts

/** Render the `subagent_status` tool body from a report. */
export function formatReport(
  items: SubagentReportItem[],
  summary: SubagentCounts,
  thresholds: { staleMs: number; deadMs: number; toolGraceMs: number },
): string

export interface SubagentRegistry {
  ingest: (event: unknown) => void
  report: (filter?: SubagentFilter) => Promise<SubagentStatusReport>
  snapshot: (filter?: SubagentFilter) => SubagentReportItem[]
  reconcile: () => Promise<void>
  hydrate: () => Promise<void>
  get: (sessionID: string) => SubagentReportItem | undefined
  classify: (sessionID: string) => SubagentStatus | undefined
}

export interface StatusToolResult {
  title: string
  output: string
  metadata: {
    subagents: SubagentReportItem[]
    counts: SubagentCounts
    staleThresholdMs: number
    deadThresholdMs: number
    toolGraceMs: number
  }
}

export interface StatusTool {
  execute: (args: { parent?: string; status?: SubagentStatus }) => Promise<StatusToolResult>
}

export interface SubagentStatusFeature {
  tool: { subagent_status: StatusTool } & Record<string, unknown>
  event: (input: { event: unknown }) => Promise<void>
  dispose: () => Promise<void>
  registry: SubagentRegistry
}

export function createSubagentStatus(options?: {
  now?: () => number
  threshold?: () => number
  deadThreshold?: () => number
  toolGrace?: () => number
  retention?: () => number
  reconcileIntervalMs?: number
  client?: { session?: { list?: Function; status?: Function; messages?: Function } }
  directory?: string
}): SubagentStatusFeature
