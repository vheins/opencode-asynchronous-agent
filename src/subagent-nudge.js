/**
 * Opt-in orphan-only resume nudge for background subagents (OpenCode V1 plugin).
 *
 * When OpenCode restarts, every in-memory registry is lost. A child session that
 * was mid-turn before the restart becomes an ORPHAN: its process is dead, no
 * `session.idle` / `session.error` will ever arrive, but its history is intact
 * in SQLite. Issuing `session.promptAsync` on that session starts a new turn on
 * top of the preserved history, which effectively resumes it.
 *
 * This module makes that recovery automatic, and only for genuine orphans. A
 * child is nudged when ALL of the following hold:
 *
 *   1. it is tracked in the status registry with a `parentID` (a real child),
 *   2. the registry classifies it `stale` or `dead`,
 *   3. its `activity` is `idle` (no in-flight tool call — a long `bash` build
 *      must never be interrupted), and
 *   4. it is ABSENT from `client.session.status()`.
 *
 * Condition 4 is the point: absence means the running process does not know the
 * session, so nobody will ever finish it. A child the SDK reports as `busy` or
 * `retry` is working and is skipped. A child the SDK reports as `idle` merely
 * lost its completion event, so it is marked `done` and never nudged.
 *
 * Nudges are backoff-gated per child (`afterMs * 2 ** attempts`, plus ±10%
 * jitter), capped per child (`OPENCODE_SUBAGENT_NUDGE_MAX`, default 2), and
 * capped per tick (three children) so a restart with many orphans does not
 * start many model turns at once. A child that exhausts its attempts has its
 * record marked terminal once and produces one "gave up" notice through the
 * injected `notify` callback; the module holds no session-injection logic.
 *
 * The whole thing is timer-driven (never subscribed to the event fan-out) and
 * follows the `cleanup.js` WAL-governor pattern: `setInterval` + `unref()` +
 * `dispose()`. Every SDK call is wrapped so a failing tick logs (in debug) and
 * returns instead of throwing.
 *
 * Opt-in via `OPENCODE_SUBAGENT_NUDGE=1` (or `true` / `yes` / `on` / `y`).
 *
 * @module subagent-nudge
 */

import { nudgeEnabled, resolveTarget, unwrap } from "./subagent-utils.js"

// The opt-in gate lives in the dependency-free utils module (with every other
// feature gate) so the core hook can read it without loading this module.
// Re-exported here so this module's public surface stays self-contained.
export { nudgeEnabled }

/** Default staleness age (ms) required before a child is nudged. */
export const DEFAULT_NUDGE_AFTER_MS = 300000

/** Default maximum nudge attempts per child. */
export const DEFAULT_NUDGE_MAX = 2

/** Default interval (ms) between nudge ticks. */
export const DEFAULT_NUDGE_CHECK_MS = 60000

/** Default resume prompt injected into an orphaned child. */
export const DEFAULT_NUDGE_PROMPT =
  "Continue your task from where you left off. If you cannot proceed, state the blocker in one line and stop. Do not restate work already completed."

/** Max children nudged in a single tick, so a mass restart cannot stampede. */
export const MAX_NUDGES_PER_TICK = 3

/** Relative jitter applied to the backoff, keeping children out of lockstep. */
const JITTER_RATIO = 0.1

/**
 * Read a positive numeric env override, falling back to `fallback`.
 *
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function envNumber(key, fallback) {
  const raw = Number(String(process.env[key] ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Configured staleness age (ms) a child must exceed before it is nudged.
 * Doubles as the base of the exponential backoff. Defaults to 5 minutes.
 *
 * @returns {number}
 */
export function nudgeAfterMs() {
  return envNumber("OPENCODE_SUBAGENT_NUDGE_AFTER_MS", DEFAULT_NUDGE_AFTER_MS)
}

/**
 * Configured max nudge attempts per child. Defaults to 2. Always an integer
 * of at least 1, so the "gave up" notice can never fire before a first try.
 *
 * @returns {number}
 */
export function nudgeMax() {
  return Math.max(1, Math.floor(envNumber("OPENCODE_SUBAGENT_NUDGE_MAX", DEFAULT_NUDGE_MAX)))
}

/**
 * Configured interval (ms) between nudge ticks. Defaults to 60 seconds.
 *
 * @returns {number}
 */
export function nudgeCheckMs() {
  return envNumber("OPENCODE_SUBAGENT_NUDGE_CHECK_MS", DEFAULT_NUDGE_CHECK_MS)
}

/**
 * Resume text injected into an orphaned child. `OPENCODE_SUBAGENT_NUDGE_PROMPT`
 * overrides {@link DEFAULT_NUDGE_PROMPT}; an empty override is ignored.
 *
 * @returns {string}
 */
export function nudgePrompt() {
  const raw = String(process.env.OPENCODE_SUBAGENT_NUDGE_PROMPT ?? "").trim()
  return raw || DEFAULT_NUDGE_PROMPT
}

/**
 * Whether debug logging is enabled via `OPENCODE_SUBAGENT_NUDGE_DEBUG=1`.
 *
 * @returns {boolean}
 */
export function nudgeDebug() {
  return String(process.env.OPENCODE_SUBAGENT_NUDGE_DEBUG ?? "") === "1"
}

/**
 * Exponential backoff before the next attempt for a child that has already
 * been nudged `attempts` times: `afterMs * 2 ** attempts`. The exponent is
 * clamped so a long-lived child cannot overflow to `Infinity`.
 *
 * @param {number} attempts
 * @param {number} afterMs
 * @returns {number}
 */
function backoffMs(attempts, afterMs) {
  const exponent = Math.min(Math.max(0, attempts), 30)
  return afterMs * 2 ** exponent
}

/**
 * Create the resume-nudge feature.
 *
 * @param {{
 *   client?: { session?: { status?: Function, get?: Function, promptAsync?: Function } },
 *   registry?: { snapshot: Function, hydrate?: Function, ingest?: Function },
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   notify?: (message: string) => void,
 *   random?: () => number,
 *   debug?: boolean,
 * }} [options]
 * @returns {{ start: () => unknown, tick: () => Promise<void>, dispose: () => void }}
 */
export function createSubagentNudge(options = {}) {
  const client = options.client
  const registry = options.registry
  const now = options.now ?? (() => Date.now())
  const notify = typeof options.notify === "function" ? options.notify : undefined
  const random = typeof options.random === "function" ? options.random : Math.random
  const debug = options.debug ?? nudgeDebug()
  const log = typeof options.log === "function" ? options.log : (message) => console.error(message)

  /** Per-child nudge state machine: attempts made, last send time, gave up. */
  const states = new Map()
  /** Timer handle while started; `undefined` when stopped. */
  let timer
  /** Overlap guard: a tick that is still running makes the next one a no-op. */
  let running = false
  /** Log the "status unavailable" case once instead of every tick. */
  let statusMissingLogged = false

  /** Emit a debug line only when debug logging is enabled. */
  function debugLog(message) {
    if (!debug) return
    try {
      log(`[opencode-subagent-nudge] ${message}`)
    } catch {
      // Logging must never break a tick.
    }
  }

  /** Deliver the one-shot "gave up" notice; a throwing callback is swallowed. */
  function safeNotify(message) {
    if (!notify) return
    try {
      notify(message)
    } catch {
      // A failed notice must never abort the tick.
    }
  }

  /** Short human label for a child record in logs and the give-up notice. */
  function labelOf(item) {
    const id = typeof item?.sessionID === "string" ? item.sessionID : "?"
    const name = typeof item?.title === "string" && item.title ? ` (${item.title})` : ""
    return `${id}${name}`
  }

  /**
   * Feed a synthetic registry event so the status registry records the terminal
   * transition. A missing `ingest` (minimal stub) is a silent no-op.
   */
  function markTerminal(id, type) {
    if (typeof registry?.ingest !== "function") return
    try {
      registry.ingest({ type, properties: { sessionID: id } })
    } catch {
      // Bookkeeping only: a rejected ingest must never break the tick.
    }
  }

  /** Whether a child is old enough to be considered for a nudge. */
  function stalenessOf(item, current) {
    if (Number.isFinite(item?.sinceLastProgressMs)) return item.sinceLastProgressMs
    if (Number.isFinite(item?.lastProgressAt)) return current - item.lastProgressAt
    return Number.POSITIVE_INFINITY
  }

  /**
   * Send one resume prompt to `id`, preserving the child's own agent/model/
   * variant. Identity resolution is best effort: when `session.get` is missing
   * or fails the prompt is still sent without a target.
   *
   * @param {string} id
   * @returns {Promise<boolean>} whether `promptAsync` accepted the prompt
   */
  async function sendNudge(id) {
    const api = client?.session
    if (typeof api?.promptAsync !== "function") {
      debugLog(`session.promptAsync is unavailable; cannot nudge ${id}`)
      return false
    }

    let target = {}
    if (typeof api?.get === "function") {
      try {
        target = resolveTarget(unwrap(await api.get({ path: { id } })))
      } catch (error) {
        target = {}
        debugLog(`could not resolve identity for ${id}: ${errorText(error)} (sending without target)`)
      }
    } else {
      debugLog(`session.get is unavailable; nudging ${id} without a target`)
    }

    try {
      await api.promptAsync({
        path: { id },
        body: { parts: [{ type: "text", text: nudgePrompt() }], ...target },
      })
      return true
    } catch (error) {
      debugLog(`promptAsync failed for ${id}: ${errorText(error)}`)
      return false
    }
  }

  /**
   * One tick of the nudge loop. Never throws: any failure logs (when debug) and
   * returns.
   *
   * @returns {Promise<void>}
   */
  async function runTick() {
    if (!registry || typeof registry.snapshot !== "function") return

    let items = registry.snapshot()
    // Populate an empty registry from the SDK (the restart case). Hydration is
    // only needed while the registry holds nothing — once it is populated the
    // event fan-out keeps it fresh, so a tick with nothing to consider issues
    // no SDK call at all.
    //
    // No opt-out is needed: reconciliation never materialises `done` from
    // absence in the SDK status map, it leaves the record in the derived
    // `stale`/`dead` tier. That is exactly the orphan signal this job reads.
    if (items.length === 0) {
      if (typeof registry.hydrate !== "function") return
      try {
        await registry.hydrate()
      } catch (error) {
        debugLog(`registry.hydrate failed: ${errorText(error)}`)
        return
      }
      items = registry.snapshot()
    }
    if (!Array.isArray(items) || items.length === 0) return

    const children = items.filter((item) => item && typeof item.parentID === "string" && item.parentID)
    if (children.length === 0) return

    // Cheap, SDK-free pre-filter: only a stale/dead child with an idle
    // activity is ever a nudge candidate. When none survive there is nothing
    // to test against the SDK, so no `session.status()` call is made.
    const candidates = children.filter(
      (item) =>
        typeof item.sessionID === "string" &&
        item.sessionID &&
        (item.status === "stale" || item.status === "dead") &&
        item.activity === "idle",
    )
    if (candidates.length === 0) return

    const api = client?.session
    if (typeof api?.status !== "function") {
      if (!statusMissingLogged) {
        statusMissingLogged = true
        debugLog("session.status is unavailable; orphan detection is disabled")
      }
      return
    }

    let map
    try {
      map = unwrap(await api.status())
    } catch (error) {
      debugLog(`session.status failed: ${errorText(error)}`)
      return
    }
    if (!map || typeof map !== "object") return

    const current = now()
    const afterMs = nudgeAfterMs()
    const max = nudgeMax()

    /** Children that pass the orphan test and may be nudged this tick. */
    const eligible = []
    for (const item of candidates) {
      const id = item.sessionID
      if (Object.prototype.hasOwnProperty.call(map, id)) {
        // A lost completion event, not an orphan: the process still knows this
        // session and reports it idle, so mark it done and never prompt it.
        if (map[id]?.type === "idle") markTerminal(id, "session.idle")
        continue
      }
      // Absent from the status map => orphan. A stale/dead idle child with no
      // in-flight tool call is safe to resume.
      eligible.push(item)
    }

    /** Children selected for a nudge this tick, after the state machine. */
    const picked = []
    for (const item of eligible) {
      const id = item.sessionID
      let state = states.get(id)
      if (!state) {
        state = { attempts: 0, lastAttemptAt: Number.NEGATIVE_INFINITY, gaveUp: false }
        states.set(id, state)
      }
      if (state.gaveUp) continue

      if (state.attempts >= max) {
        // Attempts exhausted: mark the record terminal ONCE and notify ONCE.
        state.gaveUp = true
        markTerminal(id, "session.error")
        safeNotify(`subagent nudge: giving up on ${labelOf(item)} after ${state.attempts} attempt(s)`)
        continue
      }

      // A first nudge requires the child to be stale by at least `afterMs`;
      // subsequent attempts are additionally gated by the exponential backoff.
      if (stalenessOf(item, current) < afterMs) continue
      const backoff = backoffMs(state.attempts, afterMs)
      const jittered = backoff * (1 + JITTER_RATIO * (random() * 2 - 1))
      if (current - state.lastAttemptAt < jittered) continue

      picked.push(item)
      if (picked.length >= MAX_NUDGES_PER_TICK) break
    }

    for (const item of picked) {
      const id = item.sessionID
      const state = states.get(id)
      // Count the attempt before sending: a rejecting `promptAsync` still
      // consumes an attempt and its backoff, so a failing child is never
      // hammered once per tick.
      state.attempts += 1
      state.lastAttemptAt = current
      const sent = await sendNudge(id)
      debugLog(
        `nudged ${labelOf(item)} attempt ${state.attempts}/${max}` + (sent ? "" : " (send failed)"),
      )
    }
  }

  /**
   * Run one tick, refusing to overlap with a tick that is still in flight.
   *
   * @returns {Promise<void>}
   */
  async function tick() {
    if (running) return
    running = true
    try {
      await runTick()
    } catch (error) {
      debugLog(`tick failed: ${errorText(error)}`)
    } finally {
      running = false
    }
  }

  /**
   * Start the periodic timer. Idempotent while running. The handle is `unref`'d
   * so a pending tick never holds the process open.
   *
   * @returns {unknown} the interval handle
   */
  function start() {
    if (timer) return timer
    // Without a registry there is nothing to inspect, so installing an interval
    // would only wake the process to do nothing.
    if (!registry || typeof registry.snapshot !== "function") {
      debugLog("no status registry; the nudge timer is not started")
      return undefined
    }
    timer = setInterval(() => {
      void tick()
    }, nudgeCheckMs())
    timer.unref?.()
    return timer
  }

  /** Stop the timer and drop the per-child state. */
  function dispose() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    states.clear()
  }

  return { start, tick, dispose }
}

/**
 * Best-effort one-line description of an error, for debug logs.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
