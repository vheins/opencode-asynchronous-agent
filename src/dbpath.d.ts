/**
 * Type surface for {@link ./dbpath.js}. The implementation is plain runtime
 * JavaScript (matching src/cleanup.js, which tsc does not compile), so this
 * declaration lets TypeScript modules and tests import it with full types.
 */

export interface ResolveDbPathOptions {
  env?: Record<string, string | undefined>
  dataDir?: string
  readdir?: (dir: string) => string[]
  mtime?: (path: string) => number
}

export function resolveDbPath(options?: ResolveDbPathOptions): string | undefined

export function defaultDataDir(env?: Record<string, string | undefined>): string
