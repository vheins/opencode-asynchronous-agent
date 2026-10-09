import { statSync } from "node:fs"
import { resolveDbPath } from "./dbpath"

/** Binary (1024-based) size units, largest last; the formatter stops at TB. */
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/**
 * Formats a byte count as a human-readable string in binary units
 * (KB/MB/GB/TB, 1024-based), with one decimal place above bytes. Returns an em
 * dash for a missing or invalid count so callers can render a placeholder.
 */
export function humanBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—"
  let value = bytes
  let unit = 0
  while (unit < SIZE_UNITS.length - 1 && value >= 1024) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  // Carry when one-decimal rounding would read 1024.0 (e.g. 1_048_575 B).
  if (unit < SIZE_UNITS.length - 1 && value.toFixed(1) === "1024.0") {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`
}

/** Cached DB path; `null` means "not resolved yet", `undefined` means "none". */
let cachedDbPath: string | undefined | null = null

/**
 * Reads the in-use OpenCode database size in bytes with a single stat. The
 * resolved path is cached; when the file is unavailable the next call
 * re-resolves it, so a database that appears later is picked up without a
 * directory scan on every tick.
 */
export function readDbSizeBytes(): number | undefined {
  if (cachedDbPath === null) cachedDbPath = resolveDbPath()
  const path = cachedDbPath
  if (!path || path === ":memory:") return undefined
  try {
    return statSync(path).size
  } catch {
    cachedDbPath = null
    return undefined
  }
}
