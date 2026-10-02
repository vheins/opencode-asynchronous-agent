/**
 * OpenCode V1 + V2 plugin entry point.
 *
 * OpenCode resolves a plugin directory through its `server` entrypoint
 * (root `server.js` or the `./server` export in package.json). This file
 * re-exports the dual definition from ./src/index.js, whose default export
 * carries both `id`/`setup` (V2) and `server` (V1).
 */
export { default } from "./src/index.js"
export * from "./src/index.js"
