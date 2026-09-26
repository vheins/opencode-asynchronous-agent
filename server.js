/**
 * OpenCode V2 plugin entry point.
 *
 * OpenCode V2 resolves a plugin directory through its `server` entrypoint
 * (root `server.js` or the `./server` export in package.json). This file
 * re-exports the V2 definition from ./src/index.js.
 */
export { default } from "./src/index.js"
export * from "./src/index.js"
