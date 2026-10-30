# Model Throughput Panel: project guide

## What this is

A Paperclip plugin, id `rukoz.throughput-panel`, that puts a small floating panel in the bottom-right corner of every signed-in Paperclip page. The panel shows:

- the live tokens/sec of the company's local model server (vLLM serving `swift-1.5` on hpcserver), read by the plugin worker;
- from RUK-249 on, the Claude plan usage of the signed-in user's default Claude subscription (5-hour session, weekly, weekly Fable), read by the panel itself from Paperclip's own API. The 5-hour and weekly numbers come from the `rate_limit_event` lines Claude Code writes into Claude agent run logs. Fable, plus a second reading of the other two, comes from Anthropic's usage check through Paperclip's AI-connection usage route.

Its one user is the board operator who owns this Paperclip instance and watches the agents work. `README.md` is the user-facing manual (install, configure, verify, troubleshoot); this file is for agents working on the code.

## Where it runs

- Paperclip runs on this Mac as the launchd service `ing.paperclip.paperclipai`. The service runs `~/.local/bin/paperclipai run --instance default`, a shim for the managed install at `~/.paperclip/cli/current`. Since 2026-10-30 that is 2026.1029.0-nightly.1, moved there at the user's request (it was 2026.1023.0). The user's launchd job `com.drukoz.paperclip-local-patches` re-applies local patches to the installed Paperclip every 30 minutes and may restart it.
- The plugin is installed from a local path: this repository's managed checkout, `~/.paperclip/instances/default/projects/f5895970-0d60-4783-9d98-ee75e99a924b/beea1c91-3d42-4a92-b871-27082af1144e/_default`. The host runs `dist/worker.js` in a worker process and serves `dist/ui/` to the browser at `/_plugins/rukoz.throughput-panel/ui/`.
- The worker scrapes `http://127.0.0.1:18081/metrics`, a tunnel to hpcserver. The browser cannot reach that address, which is why the worker scrapes it.
- The panel's UI code runs inside the Paperclip page with the user's board session. It can call Paperclip's HTTP API (`/api/...`) directly with `fetch(url, { credentials: "include" })`. The worker cannot: it has no board session.

## Layout

```
src/manifest.ts        plugin manifest: id, capabilities, config schema, the appShellOverlay slot
src/worker.ts          worker: config resolution, poll loop, the "throughput" data handler
src/snapshot.ts        builds the ThroughputSnapshot the UI reads
src/types.ts           worker-to-UI contract (MetricsSample, ThroughputSnapshot, ...)
src/windows.ts         the 1m / 5m / 15m average windows
src/metrics/           Prometheus text parser and the rate window
src/ui/index.tsx       the ThroughputPanel component (the whole panel)
src/ui/format.ts       display formatters; src/ui/window.ts window helpers; src/ui/Sparkline.tsx
src/usage/             Claude plan usage (RUK-249): contract, meter selection, usage-check client, run-log parser and reader, stored check state, view
scripts/build.mjs      esbuild bundling through the SDK's bundler presets
```

Tests sit next to the code as `<name>.test.ts`.

## Commands

Run from the repository root (in a worktree, its root). Node is 24.22 (`/opt/homebrew/opt/node@24/bin`).

| Command | What it does | Expected |
| --- | --- | --- |
| `npm ci` | installs dependencies; a fresh worktree has no `node_modules/` | exit 0 |
| `npm run typecheck` | `tsc --noEmit` | no output, exit 0 |
| `npm test` | `node --test`: runs every `*.test.ts` under the current folder | `fail 0` |
| `npm run build` | writes `dist/worker.js`, `dist/manifest.js`, `dist/ui/index.js` | three `built ...` lines |

There is no linter and no formatter; match the surrounding code (2-space indent, double quotes, semicolons, trailing commas).

## Conventions

- TypeScript 7 (`typescript ^7.0.2`), ES modules, `module: nodenext`. Relative imports keep their extension: `import { selectPlanUsage } from "./select.ts";`.
- `verbatimModuleSyntax` is on: a type-only import must be `import type { ... }`.
- `erasableSyntaxOnly` is on, because Node runs the `.ts` files directly with type stripping: no `enum`, no `namespace`, no constructor parameter properties.
- `noUncheckedIndexedAccess` is on: `array[i]` has type `T | undefined`.
- Tests use `node:test` and `node:assert/strict` only. There is no jsdom and no React renderer, so keep logic in pure functions and test those; React components are checked by `npm run typecheck` and `npm run build`.
- UI: React 19 function components with inline `CSSProperties` styles; no CSS files. React is provided by the host at runtime (the bundler marks it external). Palette: text `#fafafa`, muted `rgba(250,250,250,0.55)`, ok `#22c55e`, warning `#f59e0b`, error `#ef4444`, idle `#a1a1aa`.
- Comments explain why, not what. JSDoc on exported functions and types.
- No new dependencies unless the task spec says so.

## Pinned versions

- Node >= 24.11 (`engines` in `package.json`); 24.22.1 is installed.
- `@paperclipai/plugin-sdk` 2026.1023.0. The host now runs 2026.1029.0-nightly.1, and the routes and response fields this plugin reads were rechecked there on 2026-10-30. Do not upgrade the SDK as a side effect of other work.
- Paperclip API shapes this plugin reads are copied into `src/usage/types.ts` from `@paperclipai/shared` 2026.1023.0. The fields the plugin reads are unchanged in 2026.1029.0-nightly.1, which only adds a `github` provider and an optional `environmentId`.

## Branches and delivery

- There is no GitHub remote; nothing is pushed anywhere. `main` holds only the initial commit.
- The live plugin is built from `feature/ruk-19-throughput-panel`, which is checked out in the `_default` checkout.
- Each parent task gets its own branch from it, for example `feature/ruk-249-claude-plan-usage`. Each subtask works in its own git worktree under `/Volumes/Storage/paperclip/worktrees/paperclip-throughput-panel/`, on a branch named `<feature-branch>-RUK-<n>`. Commit on the worktree's current branch; never switch or create branches.
- At delivery the CTO merges the feature branch into `feature/ruk-19-throughput-panel` in `_default` and runs `npm run build` there. The user then reloads the Paperclip page.

## Dangers

- The `_default` checkout is the live plugin. `npm run build` there deletes and rewrites `dist/`, which the host serves to the user's browser. Only the CTO builds, commits or changes branches in `_default`, and only at delivery.
- Never restart Paperclip or touch the launchd agents in `~/Library/LaunchAgents`: a restart kills every agent run in progress.
- The worker process does not reload when `dist/worker.js` changes. Worker changes reach users only after a plugin disable/enable or a Paperclip restart, both of which the board operator does.
- Every call to `GET /api/companies/:companyId/ai-connections/:connectionId/usage` reads the stored Claude credential, writes a row to Paperclip's secret access log, and asks Anthropic, which rate-limits it hard: on 2026-10-30 the panel's first checks all came back 429. The panel calls it at most every 15 minutes (30 after a 429), and shares that schedule across tabs through `localStorage`. Do not add another caller or shorten the interval; read numbers from agent run logs instead.
- Run logs hold full agent transcripts. The panel reads only the ends of the 3 newest Claude runs' logs (`GET /api/heartbeat-runs/:runId/log?offset=…&limitBytes=…`), and reads a run again only when its size has changed. The first read starts 256 KiB before the run's `lastOutputBytes` and asks for 512 KiB, because Paperclip saves `lastOutputBytes` only once a minute and the file can be ahead of it. Claude Code writes a `rate_limit_event` only at a run's first response and when the 5-hour figure moves by a whole percent, so when that read finds none the reader steps back at most 3 times, 512 KiB each plus a 64 KiB overlap (576 KiB per request), never below the size an earlier read already searched: about 1.75 MiB before `lastOutputBytes` in all. On 2026-10-30 the farthest last event in 14 finished CTO runs was 0.56 MB before the end. It keeps only the parsed `rate_limit_event` numbers. Never display, store or send other log content, and never read whole logs in a poll.
- The `/api/plugins` routes need a board instance-admin credential; an agent key gets `403`. Do not loop on them.
- Never commit a token, key or secret value, including in test fixtures.
