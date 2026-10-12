/**
 * Packaging smoke test for GitHub issue #1.
 *
 * Guards the regression where the published `./server` entry failed to import
 * from a clean install because `@opencode-ai/plugin` was declared only as a
 * devDependency: npm does not install a dependency's devDependencies, so the
 * static import of the plugin package threw `Cannot find module` and took the
 * whole entry (including the core `tool.execute.before` background hook) down.
 *
 * The test is a true end-to-end oracle: it packs the real tarball, installs it
 * into an empty temp project, and imports the published `./server` entry under
 * Bun. It asserts two things:
 *
 *   1. With all dependencies present, `default.server()` registers the core
 *      `tool.execute.before` hook.
 *   2. With `@opencode-ai/plugin` hidden (simulating the optional dependency
 *      being unavailable), the entry STILL imports and registers the core hook;
 *      only the plugin-backed opt-in features degrade.
 *
 * Run via `npm run smoke` (also wired to `prepublishOnly`).
 *
 * @module pack-smoke
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))

/** Run a command, returning its result; never throws on a non-zero exit. */
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options })
}

/** Fail the smoke test with a message and exit code. */
function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/** Assert the last run succeeded, surfacing its output on failure. */
function expectOk(result, label) {
  if (result.status !== 0) {
    console.error(`--- ${label} stdout ---\n${result.stdout ?? ""}`)
    console.error(`--- ${label} stderr ---\n${result.stderr ?? ""}`)
    fail(`${label} exited with code ${result.status}`)
  }
}

const work = mkdtempSync(join(tmpdir(), "oc-async-smoke-"))
const appDir = join(work, "app")

/**
 * Write the in-app assertion script. It imports the PUBLISHED `./server`
 * subpath (not a relative path) and checks that the core hook is registered.
 */
const CHECK_SOURCE = `
import pkg from "${pkg.name}/server"

if (!pkg || typeof pkg.server !== "function") {
  console.error("FAIL: default export has no server() function")
  process.exit(1)
}
const hooks = await pkg.server({ directory: process.cwd() })
if (typeof hooks?.["tool.execute.before"] !== "function") {
  console.error("FAIL: server() did not register tool.execute.before; hooks=" + Object.keys(hooks ?? {}).join(","))
  process.exit(1)
}
console.log("SMOKE_OK tool.execute.before registered")
`

try {
  // 1. Pack the real tarball into the temp dir.
  const pack = run("npm", ["pack", "--pack-destination", work], { cwd: repoRoot })
  expectOk(pack, "npm pack")
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"))
  if (!tarball) fail(`no .tgz produced in ${work}`)
  const tarballPath = join(work, tarball)
  console.log(`packed ${tarball}`)

  // 2. Install the tarball into an empty project (no repo node_modules on the path).
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "smoke-app", private: true, type: "module" }, null, 2))
  const install = run("npm", ["install", "--no-audit", "--no-fund", tarballPath], { cwd: appDir })
  expectOk(install, "npm install")
  console.log("installed tarball into a clean temp project")

  // 3. The declared runtime dependency must be present after install.
  const installedPlugin = join(appDir, "node_modules", "@opencode-ai", "plugin")
  if (!existsSync(installedPlugin)) {
    fail("@opencode-ai/plugin was not installed from the tarball's dependencies")
  }

  writeFileSync(join(appDir, "check.mjs"), CHECK_SOURCE)

  // Enable a plugin-backed opt-in feature so both runs exercise the lazy-load
  // path: it resolves in the full-dependency run and must degrade (not throw) in
  // the hidden-dependency run.
  const checkEnv = {
    ...process.env,
    BUN_BE_BUN: "1",
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    OPENCODE_SUBAGENT_STATUS: "1",
  }

  // 4a. Full-dependency path: the entry loads and registers the core hook.
  const full = run("bun", ["check.mjs"], { cwd: appDir, env: checkEnv })
  if (!String(full.stdout ?? "").includes("SMOKE_OK")) {
    console.error(`--- full-deps stdout ---\n${full.stdout ?? ""}`)
    console.error(`--- full-deps stderr ---\n${full.stderr ?? ""}`)
    fail("full-dependency import did not register the core hook")
  }
  console.log("OK: clean install imports ./server and registers tool.execute.before")

  // 4b. Optional-dependency-missing path: hide the plugin package and re-import.
  // The core hook must still register; only plugin-backed features degrade.
  const hidden = join(work, "plugin-hidden")
  renameSync(installedPlugin, hidden)
  const degraded = run("bun", ["check.mjs"], { cwd: appDir, env: checkEnv })
  renameSync(hidden, installedPlugin)
  if (!String(degraded.stdout ?? "").includes("SMOKE_OK")) {
    console.error(`--- degraded stdout ---\n${degraded.stdout ?? ""}`)
    console.error(`--- degraded stderr ---\n${degraded.stderr ?? ""}`)
    fail("entry failed to register the core hook with @opencode-ai/plugin unavailable")
  }
  if (!String(degraded.stderr ?? "").includes("could not be loaded")) {
    console.error(`--- degraded stderr ---\n${degraded.stderr ?? ""}`)
    fail("expected a graceful degradation warning when @opencode-ai/plugin is unavailable")
  }
  console.log("OK: core hook stays independent when @opencode-ai/plugin is unavailable")

  console.log("SMOKE PASS")
} finally {
  rmSync(work, { recursive: true, force: true })
}
