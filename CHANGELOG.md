# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- TUI status line shows the size of the in-use `opencode.db` in human-readable
  units (KB/MB/GB/TB), read on a slow poll and resolved with the same path logic
  as the cleanup module (FEAT-040).
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

[Unreleased]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/vheins/opencode-asynchronous-agent/compare/v0.10.7...v0.11.0
[0.10.7]: https://github.com/vheins/opencode-asynchronous-agent/releases/tag/v0.10.7
