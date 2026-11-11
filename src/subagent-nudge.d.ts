/**
 * Type surface for {@link ./subagent-nudge.js}. The implementation is plain
 * runtime JavaScript, so this declaration lets TypeScript tests import it with
 * full types.
 */

export const DEFAULT_NUDGE_AFTER_MS: number
export const DEFAULT_NUDGE_MAX: number
export const DEFAULT_NUDGE_CHECK_MS: number
export const DEFAULT_NUDGE_PROMPT: string
export const MAX_NUDGES_PER_TICK: number

export function nudgeEnabled(): boolean
export function nudgeAfterMs(): number
export function nudgeMax(): number
export function nudgeCheckMs(): number
export function nudgePrompt(): string
export function nudgeDebug(): boolean

/** Registry snapshot item consumed by the orphan test. */
export interface NudgeSnapshotItem {
  sessionID: string
  parentID?: string
  title?: string
  /** Derived registry status: `running` | `stale` | `dead` | `done` | `error`. */
  status: string
  /** `tool` while a call is in flight, `streaming` when progress is fresh, else `idle`. */
  activity: string
  sinceLastProgressMs?: number
  lastProgressAt?: number
}

/** The subset of the status registry the nudge job reads. */
export interface NudgeRegistry {
  snapshot: () => NudgeSnapshotItem[]
  /** Populate from the SDK. Absence from the status map never implies `done`. */
  hydrate?: () => Promise<void>
  ingest?: (event: unknown) => void
}

/** The subset of the OpenCode client the nudge job calls. */
export interface NudgeClient {
  session?: {
    status?: () => Promise<unknown>
    get?: (input: { path: { id: string } }) => Promise<unknown>
    promptAsync?: (input: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
  }
}

export interface SubagentNudgeFeature {
  /** Start the periodic tick; idempotent while running. */
  start: () => unknown
  /** Run a single tick manually (tests / one-shot recovery). */
  tick: () => Promise<void>
  /** Clear the timer and drop per-child state. */
  dispose: () => void
}

export function createSubagentNudge(options?: {
  client?: NudgeClient
  registry?: NudgeRegistry
  now?: () => number
  log?: (message: string) => void
  notify?: (message: string) => void
  random?: () => number
  debug?: boolean
}): SubagentNudgeFeature
