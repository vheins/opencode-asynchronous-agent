# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] - 2026-11-11

Subagent liveness rework: background children that are dead or stalled are no
longer reported as `running`, the control tools share one source of truth, and
orphaned children can be resumed automatically.

### Changed

- The completion notice is now two dense lines carrying **outcome**, duration,
  tool-call count and context used, instead of a single 227-character sentence
  that had four redundancies and stated "completed" for children that had
  actually **errored**. The `(@agent subagent)` title suffix is stripped (the
  agent is already on the line), the instruction boilerplate
  (`the subagent finished processing your queued message. Read its answer with
  subagent_result.`) is gone, the session id appears once in copy-ready
  `sessionID=<id>` form, and unknown segments are omitted rather than
  placeholdered. The injected part also carries structured metadata so the model
  never has to parse prose. This matters because each injected notice costs the
  parent a full model turn.

### Fixed

- A child absent from the SDK status map was materialised as `done`, which made
  the derived `dead` tier **unobservable**: a wedged child read `running → done`,
  `subagent_result` returned an empty answer, and the documented
  `dead → subagent_cancel` remediation could never fire. Absence means *unknown*,
  not success — the SDK map only carries live-engine sessions. A child is now
  concluded finished only on a positive signal (engine-reported `idle`, or a real
  final assistant answer), and a derived-`dead` child is confirmed at most once
  by reading its last message so a restart orphan stays `dead` instead of being
  mistaken for a success.
- A finished child could keep reporting `activity: "tool"` and stay `running` for
  the full 30-minute grace window, because a terminal transition never cleared the
  in-flight tool tracker and activity was checked before terminal state. This
  could pin a revived child at `running` with zero real events.
- Reconciling had no in-flight guard, so two concurrent reports could run two
  passes and a slower one could move the progress clock backwards. Clock writes
  are now monotonic and concurrent reports share a single pass.
- `session.updated`/`session.created` for an untracked session stamped the
  progress clock with `now()`, so a five-hour-old session could read as freshly
  running. Both now stamp the session's own `time.updated`/`time.created`.
- `progressEvidenceAt` fell back to the weak event clock, re-opening the original
  bug for records lacking a progress timestamp; it now falls back to `startedAt`.
- `subagent_result` with `view: "auto"` treated `dead` as still-live and returned
  an activity report as if the child were working; it now reports the death and
  points at recovery.
- The completion module's child-identity cache never expired; it now shares the
  pending-notice TTL.
- Background subagents that were dead or stalled were still reported as `running`.
  Liveness was derived from *any* event, so weak events (`session.updated`, an
  unrecognised `session.status` type) refreshed the freshness clock without the
  child doing any work, and `hydrate()` stamped `lastEventAt = now()` on sessions
  that could be hours old. Staleness now derives from a separate
  `lastProgressAt` clock that only strong evidence advances (`message.updated`,
  `message.part.updated`, `todo.updated`, a `busy`/`retry` session status), and
  reconciliation with the SDK runs on every report, using `session.status()` as
  the arbiter of liveness instead of a locally invented timestamp.
- Tracked `stale` records were never evicted, so a long-lived OpenCode process
  accumulated child records forever. `sweep()` now evicts on the classified
  status and applies to `stale` and `dead` as well as `done`/`error`.
- A finished child woken up with `subagent_send` kept reporting `done` while it
  was working again; a strong progress event now revives the record to `running`.
- `subagent_children` and `subagent_status` could disagree about the same child,
  because the former read only the SDK and defaulted unknown sessions to `idle`.
  The status registry is now injected into the control suite, so both tools read
  one source of truth and unknown sessions are reported as `unknown` rather than
  a silent `idle`.
- `subagent_cancel` reported "no running session" when the build returned a
  `void`/`undefined` abort result; an accepted abort is now anything that is not
  an explicit `false`.
- `subagent_send` queued prompts into children that had already finished or died,
  and still armed a completion notice that could never fire. It now refuses with
  an actionable message unless `force: true` is passed.
- `subagent_result` could not distinguish a partial, still-streaming answer from
  a final one. It now reports `streaming`/`partial` and returns a `nextCursor`.

### Added

- Orphan resume nudges (`OPENCODE_SUBAGENT_NUDGE`, opt-in). After an OpenCode
  restart a mid-turn child is orphaned: its process is gone and no `idle`/`error`
  event will ever arrive, though its history survives. `session.promptAsync` on
  such a session starts a fresh turn on the preserved context, so the feature
  resumes it automatically. It acts only when the child is tracked, derived
  `stale`/`dead`, has **no tool call in flight**, and is **absent** from
  `session.status()` — a `busy` child is never touched and an SDK-reported `idle`
  child is simply marked done. Attempts are bounded
  (`OPENCODE_SUBAGENT_NUDGE_MAX`, default 2) with exponential backoff plus jitter,
  at most three children are nudged per tick, and the child's agent/model/variant
  are preserved. The prompt asks the child to continue rather than to report its
  status, because asking a working agent what it is doing makes it stop.

  `slug` (the session nickname), `title`, `agent`, model, token usage
  (input/output/reasoning/cache), `toolCalls` / `toolErrors` / `toolCounts`,
  and `lastActivity` (`tool:<name>` / `streaming` / `todo`) with
  `sinceLastActivityMs`. `subagent_children` renders a two-line triage entry —
  identity and status first, then cost and activity — dropping the least
  important segment when data is missing instead of printing a placeholder.
  Token totals take the newest message's values and are never summed across
  turns, and context percent is omitted entirely when the model limit is
  unknown rather than fabricated.
- `subagent_result` gained a `view` argument (`auto` | `result` | `activity` |
  `history`). It previously only hunted for the *final* assistant answer, so
  calling it on a child that was still working returned
  `No assistant answer found (the subagent may still be running)` — a dead end,
  even though the SDK had already returned the child's entire message list.
  `auto` now returns the final answer when the child is done and an **activity
  report** otherwise: in-flight tool calls with elapsed time, the current
  `in_progress` todo, the latest assistant snippet, message/tool counts, and the
  last error. `history` renders a compact chronological transcript, honouring
  `limit` and `sinceMessageID`. Reported metadata carries `activity`
  (`tool`/`streaming`/`idle`), `activeTool`, `todos`, and `inFlight`.
- An in-flight **tool call** counts as proof of life. A subagent running `bash`
  (a build, a test suite, `bun install`) can legitimately sit for many minutes
  without emitting a single session event, and previously read as `stale`/`dead`.
  The registry now tracks active tool parts and holds the child `running` for as
  long as one is in flight, up to `OPENCODE_SUBAGENT_TOOL_GRACE_MS` (default
  30 min). Report items expose `activity` (`tool`/`streaming`/`idle`) and
  `activeTool` (`{ tool, runningMs }`), and a long tool call is described as
  expected rather than as a reason to cancel.
- Two-tier liveness: `stale` (`OPENCODE_SUBAGENT_STALE_MS`, default 120 s) is a
  warning and `dead` (`OPENCODE_SUBAGENT_DEAD_MS`, default 600 s) is actionable,
  so a legitimately long tool call no longer reads as a wedged child. Both are
  derived states, never persisted, so a revived child returns to `running`
  cleanly.
- `subagent_status` items carry `lastProgressAt`, `sinceLastProgressMs`, `dead`,
  and `deadThresholdMs`, and each non-terminal child gets an actionable hint
  suggesting `subagent_result` or `subagent_cancel`.
- `subagent_result` accepts `sinceMessageID` to return only new output, so
  following a long-running child no longer re-reads the whole answer.
- `subagent_watch` reports as soon as a child's status *changes*, bounded by a
  hard timeout (`OPENCODE_SUBAGENT_WATCH_MAX_MS`, default 30 s). It polls the
  in-memory registry only, never the SDK, and is deliberately a change watcher
  rather than a completion wait.
- `OPENCODE_SUBAGENT_DONE_RETENTION_MS` and `OPENCODE_SUBAGENT_PENDING_TTL_MS`
  make record and pending-notice retention configurable; the completion notice's
  pending map now expires instead of leaking.

## [0.13.1] - 2026-10-12

### Fixed

- The `./server` entry now loads from a clean npm install: `@opencode-ai/plugin`
  is declared as a runtime dependency instead of a dev dependency (#1).
- The core background hook is decoupled from the opt-in feature modules, so a
  missing optional dependency degrades only that feature instead of breaking
  plugin startup (#1).

### Added

- Packaging smoke test (`scripts/pack-smoke.mjs`) that installs the packed
  tarball into a clean directory and asserts the `./server` entry imports with
  its `tool.execute.before` hook registered (#1).

## [0.13.0] - 2026-10-09

### Added

- TUI status line shows the size of the in-use `opencode.db` in human-readable
  units (KB/MB/GB/TB), read on a slow poll and resolved with the same path logic
  as the cleanup module (FEAT-040).

## [0.12.0] - 2026-10-09

### Added

- DB IO governor: a WAL governor that issues a non-blocking
  `wal_checkpoint(PASSIVE)` once the `-wal` sidecar exceeds
  `OPENCODE_DB_CLEANUP_WAL_THRESHOLD`, and a `wal_checkpoint(TRUNCATE)` only after
  the database has been write-idle for `OPENCODE_DB_CLEANUP_WAL_IDLE_MS`
  (FEAT-037).
- Cross-process WAL idle guard: the idle clock is derived from the shared `-wal`
  file mtime, so when several OpenCode processes share one database an idle
  process never truncates the WAL while a peer is writing (FEAT-038).
- Adaptive prune: an oversized WAL can trigger an earlier prune pass, bounded by
  `OPENCODE_DB_CLEANUP_PRUNE_FLOOR_MS` plus a random
  `OPENCODE_DB_CLEANUP_PRUNE_JITTER_MS` so concurrent processes do not prune in
  lockstep (FEAT-037, FEAT-038).

### Changed

- Progress reports default to the `chat` channel with a 300 s minimum interval
  and a cap of 5 non-final reports per child (FEAT-037).
- Completion notices are decoupled from the progress channel and default to
  `inline`, so a queued follow-up is never silenced (FEAT-037).
- The TUI status bar shows the plugin version next to the `ASYNC` label, and the
  sidebar header was removed (FEAT-034).
- TUI progress bars gained sub-cell (eighth-block) resolution, an idle shimmer, a
  `completed/total · NN%` label, a color ramp, and terminal-scaled width; rows
  collapse when `total` is 0 (FEAT-035).

## [0.11.0] - 2026-10-09

### Added

- Notification channel dimension: `OPENCODE_SUBAGENT_NOTIFICATION_TYPE`
  (`toast` | `chat` | `inline` | `both` | `off`) selects how progress and
  completion reports are delivered, independently of whether they are enabled
  (FEAT-101).

### Fixed

- Completion notices are gated by their own predicate, so
  `OPENCODE_SUBAGENT_COMPLETION_NOTIFY` works without depending on the
  progress-channel default (FIX-102).

## [0.10.7] - 2026-10-09

### Fixed

- Emit a completion notice for `subagent_send` follow-ups, and send it as a
  non-synthetic part (FIX-101, TASK-001).

_Releases before 0.10.7 predate this changelog._

[Unreleased]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/vheins/opencode-asynchronous-agent/releases/tag/v0.10.7
