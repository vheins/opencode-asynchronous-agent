import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import {
  capToolResult,
  checkpointPassive,
  cleanupEnabled,
  createCleanup,
  envNumber,
  pruneDatabase,
  reclaimSpace,
  resolveDbPath,
  resolveLimits,
  trimPartData,
  truncateMiddle,
} from "./cleanup.js"

function memoryDb() {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL)`)
  db.run(
    `CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`,
  )
  db.run(
    `CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT, data TEXT)`,
  )
  return db
}

function toolPart(output, extra = {}) {
  return JSON.stringify({
    type: "tool",
    tool: "edit",
    state: {
      status: "completed",
      output,
      time: { start: 1, end: 2 },
      metadata: extra,
    },
  })
}

test("truncateMiddle keeps head and tail and stays within budget", () => {
  const text = "a".repeat(500) + "MIDDLE" + "b".repeat(500)
  const result = truncateMiddle(text, 100)
  expect(result.length).toBeLessThanOrEqual(100)
  expect(result.startsWith("a")).toBe(true)
  expect(result.endsWith("b")).toBe(true)
  expect(result).toContain("truncated")
})

test("truncateMiddle leaves short strings untouched", () => {
  expect(truncateMiddle("hello", 100)).toBe("hello")
})

test("capToolResult caps output and UI-only metadata", () => {
  const output = {
    output: "x".repeat(200),
    metadata: {
      diff: "d".repeat(200),
      filediff: { patch: "p".repeat(200), additions: 1 },
      display: { type: "file", text: "t".repeat(200) },
      diagnostics: { "/file.php": [{ message: "e".repeat(200) }] },
    },
  }
  const changed = capToolResult(output, {
    maxOutputChars: 50,
    maxDiffChars: 50,
    maxDisplayChars: 50,
    maxDiagnosticsChars: 50,
  })
  expect(changed).toBe(true)
  expect(output.output.length).toBeLessThanOrEqual(50)
  expect(output.metadata.diff.length).toBeLessThanOrEqual(50)
  expect(output.metadata.filediff.patch.length).toBeLessThanOrEqual(50)
  expect(output.metadata.filediff.additions).toBe(1)
  expect(output.metadata.display.text.length).toBeLessThanOrEqual(50)
  expect(output.metadata.diagnostics).toEqual({})
})

test("capToolResult keeps small diagnostics", () => {
  const output = { output: "ok", metadata: { diagnostics: { "/a.php": [] } } }
  const changed = capToolResult(output, {
    maxOutputChars: 50,
    maxDiffChars: 50,
    maxDisplayChars: 50,
    maxDiagnosticsChars: 1000,
  })
  expect(changed).toBe(false)
  expect(output.metadata.diagnostics).toEqual({ "/a.php": [] })
})

test("capToolResult is a no-op for small results", () => {
  const output = { output: "small", metadata: { diff: "tiny" } }
  expect(
    capToolResult(output, { maxOutputChars: 50, maxDiffChars: 50, maxDisplayChars: 50, maxDiagnosticsChars: 50 }),
  ).toBe(false)
  expect(output.output).toBe("small")
})

test("trimPartData previews output, drops UI metadata and marks compacted", () => {
  const json = toolPart("o".repeat(5000), {
    diff: "d".repeat(5000),
    filediff: { patch: "p".repeat(5000) },
    diagnostics: { "/a.php": [{ message: "e".repeat(5000) }] },
  })
  const next = trimPartData(json, { now: 1234, previewChars: 100 })
  expect(typeof next).toBe("string")
  const part = JSON.parse(next)
  expect(part.state.output.length).toBeLessThanOrEqual(100)
  expect(part.state.time.compacted).toBe(1234)
  expect(part.state.metadata.diff).toBeUndefined()
  expect(part.state.metadata.filediff.patch).toBeUndefined()
  expect(part.state.metadata.diagnostics).toBeUndefined()
})

test("trimPartData ignores non-tool and incomplete parts", () => {
  expect(trimPartData(JSON.stringify({ type: "text", text: "hi" }), { now: 1, previewChars: 1 })).toBeUndefined()
  expect(
    trimPartData(JSON.stringify({ type: "tool", state: { status: "running" } }), { now: 1, previewChars: 1 }),
  ).toBeUndefined()
  expect(trimPartData("not json", { now: 1, previewChars: 1 })).toBeUndefined()
})

test("pruneDatabase deletes old events and trims old parts only", () => {
  const db = memoryDb()
  const now = 1_000_000_000
  const retention = 1000
  db.run("INSERT INTO session (id, time_updated) VALUES (?, ?)", ["old", now - 5000])
  db.run("INSERT INTO session (id, time_updated) VALUES (?, ?)", ["fresh", now])
  db.run("INSERT INTO event (id, aggregate_id, seq) VALUES (?, ?, ?)", ["e1", "old", 1])
  db.run("INSERT INTO event (id, aggregate_id, seq) VALUES (?, ?, ?)", ["e2", "fresh", 1])
  db.run("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)", ["p1", "old", toolPart("o".repeat(5000))])
  db.run("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)", ["p2", "fresh", toolPart("o".repeat(5000))])

  const result = pruneDatabase(db, { retentionMs: retention, partPreviewChars: 100, partBatch: 500, now })
  expect(result.sessions).toBe(1)
  expect(result.eventsDeleted).toBe(1)
  expect(result.partsTrimmed).toBe(1)

  const remainingEvents = db.query("SELECT aggregate_id FROM event").all().map((r) => r.aggregate_id)
  expect(remainingEvents).toEqual(["fresh"])

  const oldPart = JSON.parse(db.query("SELECT data FROM part WHERE id = 'p1'").get().data)
  const freshPart = JSON.parse(db.query("SELECT data FROM part WHERE id = 'p2'").get().data)
  expect(oldPart.state.output.length).toBeLessThanOrEqual(100)
  expect(oldPart.state.time.compacted).toBe(now)
  expect(freshPart.state.output.length).toBe(5000)
  expect(freshPart.state.time.compacted).toBeUndefined()
})

test("pruneDatabase does nothing when no session is inactive", () => {
  const db = memoryDb()
  db.run("INSERT INTO session (id, time_updated) VALUES (?, ?)", ["fresh", Date.now()])
  db.run("INSERT INTO event (id, aggregate_id, seq) VALUES (?, ?, ?)", ["e1", "fresh", 1])
  const result = pruneDatabase(db, { retentionMs: 1000, partPreviewChars: 100, partBatch: 10, now: Date.now() })
  expect(result).toEqual({ sessions: 0, eventsDeleted: 0, partsTrimmed: 0 })
  expect(db.query("SELECT COUNT(*) n FROM event").get().n).toBe(1)
})

test("pruneDatabase deletes events in bounded batches across many rows", () => {
  const db = memoryDb()
  const now = 1_000_000_000
  db.run("INSERT INTO session (id, time_updated) VALUES (?, ?)", ["old", now - 5000])
  for (let i = 0; i < 25; i++) {
    db.run("INSERT INTO event (id, aggregate_id, seq) VALUES (?, ?, ?)", [`e${i}`, "old", i])
  }
  const result = pruneDatabase(db, {
    retentionMs: 1000,
    partPreviewChars: 100,
    eventBatch: 10,
    partBatch: 10,
    now,
  })
  expect(result.eventsDeleted).toBe(25)
  expect(db.query("SELECT COUNT(*) n FROM event").get().n).toBe(0)
})

test("checkpointPassive never takes a blocking lock", () => {
  const db = memoryDb()
  expect(checkpointPassive(db)).toEqual({ checkpointed: true })
})

test("reclaimSpace runs a checkpoint and optional vacuum", () => {
  const db = memoryDb()
  expect(reclaimSpace(db, { vacuum: false })).toEqual({ checkpointed: true, vacuumed: false })
  expect(reclaimSpace(db, { vacuum: true })).toEqual({ checkpointed: true, vacuumed: true })
})

test("resolveDbPath prefers an explicit env override", () => {
  expect(resolveDbPath({ env: { OPENCODE_DB: "/tmp/custom.db" } })).toBe("/tmp/custom.db")
  expect(resolveDbPath({ env: { OPENCODE_DB: ":memory:" } })).toBe(":memory:")
  expect(resolveDbPath({ env: { OPENCODE_DB: "chan.db" }, dataDir: "/data" })).toBe("/data/chan.db")
})

test("resolveDbPath picks opencode.db, else the newest candidate", () => {
  expect(resolveDbPath({ env: {}, dataDir: "/data", readdir: () => ["opencode.db", "opencode-beta.db"] })).toBe(
    "/data/opencode.db",
  )
  expect(
    resolveDbPath({
      env: {},
      dataDir: "/data",
      readdir: () => ["opencode-beta.db", "opencode-dev.db"],
      mtime: (p) => (p.endsWith("beta.db") ? 5 : 1),
    }),
  ).toBe("/data/opencode-beta.db")
  expect(resolveDbPath({ env: {}, dataDir: "/data", readdir: () => ["notes.txt"] })).toBeUndefined()
})

test("cleanupEnabled defaults on and honours the off switch", () => {
  expect(cleanupEnabled({})).toBe(true)
  expect(cleanupEnabled({ OPENCODE_DB_CLEANUP: "1" })).toBe(true)
  expect(cleanupEnabled({ OPENCODE_DB_CLEANUP: "0" })).toBe(false)
  expect(cleanupEnabled({ OPENCODE_DB_CLEANUP: "off" })).toBe(false)
})

test("resolveLimits applies env overrides and defaults", () => {
  const limits = resolveLimits({ OPENCODE_DB_CLEANUP_RETENTION_MS: "3600000" })
  expect(limits.retentionMs).toBe(3_600_000)
  expect(limits.intervalMs).toBe(21_600_000)
  expect(limits.partPreviewChars).toBe(2_000)
  expect(limits.vacuum).toBe(false)
})

test("envNumber ignores non-positive and non-numeric values", () => {
  expect(envNumber({ X: "0" }, "X", 7)).toBe(7)
  expect(envNumber({ X: "-3" }, "X", 7)).toBe(7)
  expect(envNumber({ X: "abc" }, "X", 7)).toBe(7)
  expect(envNumber({ X: "12" }, "X", 7)).toBe(12)
})

test("createCleanup throttles prune passes and closes its handle", async () => {
  const db = memoryDb()
  const now = 1_000_000_000
  db.run("INSERT INTO session (id, time_updated) VALUES (?, ?)", ["old", now - 5000])
  db.run("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)", ["p1", "old", toolPart("o".repeat(5000))])

  let clock = now
  const cleanup = createCleanup({
    limits: { ...resolveLimits({}), retentionMs: 1000, intervalMs: 1000, partPreviewChars: 100 },
    dbPath: ":memory:",
    now: () => clock,
    openDb: () => db,
  })

  const first = cleanup.runPrune()
  expect(first.partsTrimmed).toBe(1)
  expect(db.query("SELECT COUNT(*) n FROM part").get().n).toBe(1)

  await cleanup.event({})
  await cleanup.event({})
  clock += 5000
  await cleanup.event({})

  await cleanup.dispose()
})
