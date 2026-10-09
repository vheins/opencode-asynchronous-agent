import solid from "@opentui/solid/bun-plugin"

/** Plugin's own version, inlined into the TUI bundle via `define`. */
const pkg = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as { version: string }

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  plugins: [solid],
})
if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
console.log("Built opencode-asynchronous-agent TUI")
