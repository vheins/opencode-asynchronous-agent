// OpenCode V2 also resolves a directory plugin entrypoint as <dir>/index.
// Mirror the ./server entry so either resolution path works.
export { default } from "./src/index.js"
export * from "./src/index.js"
