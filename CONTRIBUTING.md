# Contributing

Thanks for your interest in `@vheins/opencode-asynchronous-agent`. This document
covers how to set up a local checkout, run the checks, and send a change.

By participating you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Requirements

- [Bun](https://bun.sh) for the runtime and package manager.
- Node **>=22.13** (see `engines` in `package.json`).
- An OpenCode build (**V1 >=1.18.0** or **V2 >=2.0.0**) if you want to exercise
  the plugin end to end.

## Local setup

```sh
git clone https://github.com/vheins/opencode-asynchronous-agent.git
cd opencode-asynchronous-agent
bun install
```

## Checks

Run these before opening a pull request:

```sh
bun run build      # bundle dist/tui.js
bun run typecheck  # tsc --noEmit
bun run test       # bun test --preload @opentui/solid/preload
```

All three must pass. `bun run typecheck` and `bun run test` are the gates; there
is no repository-wide formatter or linter configured, so keep your changes
consistent with the surrounding code.

## Project layout

| Path | Contents |
| --- | --- |
| `src/index.js` | Server-side plugin: `id`/`setup` for V2, `server` for V1, and the `execute.before` hook. |
| `src/tui.tsx` | TUI sidebar plugin source (InfoCard stack, per-subagent cards). |
| `src/*.js`, `src/*.ts` | Supporting modules (status, control, progress, cleanup, workspace, model). |
| `server.js`, `index.js` | Root entrypoints that re-export `src/index.js`. |
| `dist/tui.js` | Built TUI bundle produced by `bun run build`. |
| `build.ts` | Build script for `dist/tui.js`. |

## Code style

- ES modules (`"type": "module"`); TypeScript and JavaScript are both used.
- Match the existing style in the file you are editing: naming, comments, and
  module boundaries.
- Keep functions focused and prefer the simplest correct change.
- Do not add a dependency unless it is already required by the change.

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).
Reference the task code in the subject:

```text
type(scope): [TASK-CODE] short description

- Task title
  Longer summary of what changed and why.
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Scope examples: `plugin`, `server`, `tui`.
- Keep each commit atomic: one task per commit, staging only the files that
  belong to it.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, then run the checks above.
3. Open a pull request and fill in the template. Link the related issue with
   `Closes #<number>` when applicable.
4. Keep the description focused on what changed and how it was verified.

Small, focused pull requests are easier to review and land faster.

## Reporting bugs and features

Use the [issue templates](https://github.com/vheins/opencode-asynchronous-agent/issues/new/choose)
to report a bug or request a feature.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](./SECURITY.md)
for the private reporting process.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
