/**
 * Type surface for {@link ./subagent-status.js}. The implementation is plain
 * runtime JavaScript (matching src/index.js, which tsc does not compile), so
 * this declaration lets the TypeScript unit test import it with full types.
 */

export const STATUS_TOOL_ID: string
export const DEFAULT_STALE_MS: number
export const DONE_RETENTION_MS: number

export type SubagentStatus = "running" | "done" | "error" | "stale"

export interface SubagentRecord {
  sessionID: string
  parentID: string
  title: string
  agent?: string
  status: string
  startedAt: number
  lastEventAt: number
}

export interface SubagentReportItem {
  sessionID: string
  parentID: string
  title: string
  agent?: string
  status: SubagentStatus
  stale: boolean
  startedAt: number
  lastEventAt: number
  elapsedMs: number
  sinceLastEventMs: number
}

export interface SubagentCounts {
  total: number
  running: number
  done: number
  error: number
  stale: number
}

export interface SubagentFilter {
  parent?: string
  status?: SubagentStatus
}

export function statusEnabled(): boolean
export function staleThresholdMs(): number
export function isSubagentSession(info: unknown): boolean
export function classifyStatus(
  record: { status: string; lastEventAt: number },
  now: number,
  threshold: number,
): SubagentStatus
export function formatDuration(ms: number): string

export interface SubagentStatusFeature {
  tool: Record<string, unknown>
  event: (input: { event: unknown }) => Promise<void>
  dispose: () => Promise<void>
  registry: {
    ingest: (event: unknown) => void
    report: (filter?: SubagentFilter) => Promise<{
      items: SubagentReportItem[]
      counts: SubagentCounts
      staleThresholdMs: number
    }>
    snapshot: (filter?: SubagentFilter) => SubagentReportItem[]
    hydrate: () => Promise<void>
  }
}

export function createSubagentStatus(options?: {
  now?: () => number
  threshold?: () => number
  client?: { session?: { list?: Function; status?: Function } }
  directory?: string
}): SubagentStatusFeature
