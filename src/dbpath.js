/**
 * OpenCode SQLite database path resolution, shared by the V1 cleanup module
 * and the TUI status line.
 *
 * Kept free of `bun:sqlite` so the TUI bundle (built from `src/tui.tsx`) can
 * resolve the database path without pulling the database driver in.
 *
 * @module dbpath
 */

import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolve the OpenCode SQLite database path.
 *
 * Mirrors `Database.path()`: `OPENCODE_DB` wins (absolute or `:memory:`), a
 * relative value is joined to the data directory, and otherwise the most
 * recently modified `opencode*.db` in the data directory is used (covering the
 * channel-suffixed names). Returns `undefined` when nothing is found.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   dataDir?: string,
 *   readdir?: (dir: string) => string[],
 *   mtime?: (path: string) => number,
 * }} [options]
 * @returns {string | undefined}
 */
export function resolveDbPath(options = {}) {
  const env = options.env ?? process.env
  const dataDir = options.dataDir ?? defaultDataDir(env)
  const readdir = options.readdir ?? ((dir) => readdirSync(dir))
  const mtime = options.mtime ?? ((p) => statSync(p).mtimeMs)

  const explicit = String(env.OPENCODE_DB ?? "").trim()
  if (explicit === ":memory:") return explicit
  if (explicit) {
    return explicit.startsWith("/") ? explicit : join(dataDir, explicit)
  }

  let entries
  try {
    entries = readdir(dataDir)
  } catch {
    return undefined
  }
  const candidates = entries.filter(
    (name) => name.startsWith("opencode") && name.endsWith(".db") && !name.endsWith("-wal") && !name.endsWith("-shm"),
  )
  if (candidates.length === 0) return undefined
  const preferred = candidates.find((name) => name === "opencode.db")
  if (preferred) return join(dataDir, preferred)

  let best
  let bestMtime = -1
  for (const name of candidates) {
    const full = join(dataDir, name)
    const stamp = mtime(full)
    if (stamp > bestMtime) {
      bestMtime = stamp
      best = full
    }
  }
  return best
}

/**
 * Resolve the OpenCode data directory (`$XDG_DATA_HOME/opencode` or
 * `~/.local/share/opencode`).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultDataDir(env = process.env) {
  const xdg = String(env.XDG_DATA_HOME ?? "").trim()
  const base = xdg || join(homedir(), ".local", "share")
  return join(base, "opencode")
}
