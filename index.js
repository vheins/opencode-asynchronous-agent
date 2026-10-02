// OpenCode also resolves a directory plugin entrypoint as <dir>/index.
// Mirror the ./server entry so either resolution path works (V1 + V2).
export { default } from "./src/index.js"
export * from "./src/index.js"
