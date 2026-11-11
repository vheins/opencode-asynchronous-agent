/**
 * Transcript-backed confirmation for derived-dead subagent sessions.
 *
 * Absence from the SDK status map cannot distinguish a child that finished from
 * one that wedged: the map carries only `busy`/`retry` (and occasionally
 * `idle`), so a stopped child is normally absent either way. Rather than guess,
 * a child the registry classifies `dead` is checked ONCE against its transcript:
 * a last assistant message carrying a `finish` reason or an `error` is a
 * positive signal that it really stopped, and the record becomes `done`/`error`.
 *
 * Everything is bounded: the verdict is cached per child, so repeated reports
 * cost no extra SDK call. A missing or rejecting `session.messages` method
 * leaves the child derived-dead and never throws.
 *
 * @module subagent-dead-check
 */

/**
 * Info block of the FINAL assistant answer in a transcript, or `undefined`.
 *
 * Only the LAST message counts. A trailing user message means the child was
 * handed a prompt it never answered — the restart-orphan case the nudge job
 * exists for — so an earlier assistant answer carrying `finish` must not be
 * mistaken for a completed child.
 *
 * @param {Array<{ info?: { role?: string } }>} messages
 * @returns {object | undefined}
 */
export function finalAssistantInfo(messages) {
  const list = Array.isArray(messages) ? messages : []
  const info = list[list.length - 1]?.info
  return info && info.role === "assistant" ? info : undefined
}

/**
 * Best-effort unwrap of an SDK response, tolerating a raw payload (tests) and a
 * `{ data }` envelope (SDK). Kept local so this module imports nothing.
 */
function unwrap(response) {
  if (response && typeof response === "object" && "data" in response) return response.data
  return response
}

/**
 * Build the confirm-dead probe.
 *
 * @param {{
 *   client?: { session?: { messages?: Function } },
 *   markTerminal: (record: object, status: "done" | "error", current: number) => void,
 * }} deps `markTerminal` writes the positive-signal verdict into the record.
 * @returns {{
 *   confirm: (pending: object[], current: number) => Promise<void>,
 *   forget: (sessionID: string) => void,
 *   reset: () => void,
 * }}
 */
export function createDeadConfirmer({ client, markTerminal }) {
  /** sessionID -> `done` | `error` | `dead`; one transcript probe per child. */
  const verdicts = new Map()

  /**
   * Resolve derived-dead children against their transcripts, materializing a
   * terminal state only when the transcript proves one.
   *
   * @param {object[]} pending records currently derived `dead`
   * @param {number} current
   * @returns {Promise<void>}
   */
  async function confirm(pending, current) {
    const api = client?.session
    if (typeof api?.messages !== "function") return
    for (const record of pending) {
      const cached = verdicts.get(record.sessionID)
      if (cached) {
        if (cached !== "dead") markTerminal(record, cached, current)
        continue
      }
      let messages
      try {
        messages = unwrap(await api.messages({ path: { id: record.sessionID } }))
      } catch {
        continue
      }
      if (!Array.isArray(messages)) continue
      const last = finalAssistantInfo(messages)
      const verdict = last?.error ? "error" : last?.finish ? "done" : "dead"
      // Materialize BEFORE caching: `markTerminal` forgets the cached verdict of
      // the record it terminates, so the cache write must come afterwards.
      if (verdict !== "dead") markTerminal(record, verdict, current)
      verdicts.set(record.sessionID, verdict)
    }
  }

  /** Drop the cached verdict for one child (revived, terminal, or evicted). */
  function forget(sessionID) {
    verdicts.delete(sessionID)
  }

  /** Drop every cached verdict. */
  function reset() {
    verdicts.clear()
  }

  return { confirm, forget, reset }
}
