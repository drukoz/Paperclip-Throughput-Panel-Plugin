# Model Throughput Panel: project guide

## What this is

A Paperclip plugin, id `rukoz.throughput-panel`, that puts a small floating panel in the bottom-right corner of every signed-in Paperclip page. The panel shows:

- the live tokens/sec of every model on each configured model server (up to three: hpcserver's vLLM at `127.0.0.1:18081`, the A9 Mega at `127.0.0.1:18082`, the M5U at `127.0.0.1:18083`, from RUK-949), read by the plugin worker; per model: tok/s, window average, per-request tok/s, TTFT, requests, caches;
- the Claude plan usage of the user's Claude accounts: a "Resets" row with the weekly limit's reset date and time (24-hour, in the viewer's time zone; RUK-1950 put it where the 5-hour session bar was), the weekly bar and the weekly Fable bar, from one of two sources:
  - from RUK-518 on, when Claude accounts are set in the plugin settings: one "Claude · <label>" section per account. The worker runs a tiny Claude Code request for each account (the "check", in `src/usage/probe-*.ts`) and reads the `rate_limit_event` Claude Code prints. Only while the panel is expanded, at most every `claudeCheckMinutes` per account.
  - otherwise (RUK-249): one "Claude plan" section for the signed-in user's default Claude subscription, read by the panel itself from Paperclip's API: the `rate_limit_event` lines in `claude_local` agent run logs, plus Anthropic's usage check through Paperclip's AI-connection usage route.
- Anthropic reports less than these sections can show. Since 2026-10-31 02:55 UTC, Claude Code's `rate_limit_event` for our account carries only the limiting window (`seven_day`), not `five_hour`. A Paperclip sign-in (`claude setup-token`) cannot read the usage route at all: it answers 403. So a missing Fable bar is normal, and the panel no longer shows the 5-hour window at all (RUK-1950); the data layer still reads it. When a reading has no reset time, or it has passed, the Resets row shows `—` instead of guessing. Upstream: paperclipai/paperclip#18911.

Its one user is the board operator who owns this Paperclip instance and watches the agents work. `README.md` is the user-facing manual (install, configure, verify, troubleshoot); this file is for agents working on the code.

## Where it runs

- Paperclip runs on this Mac as the launchd service `ing.paperclip.paperclipai`. The service runs `~/.local/bin/paperclipai run --instance default`, a shim for the managed install at `~/.paperclip/cli/current`. Since 2026-10-30 that is 2026.1029.0-nightly.1, moved there at the user's request (it was 2026.1023.0). The user's launchd job `com.drukoz.paperclip-local-patches` re-applies local patches to the installed Paperclip every 30 minutes and may restart it.
- The plugin is installed from a local path: this repository's managed checkout, `~/.paperclip/instances/default/projects/f5895970-0d60-4783-9d98-ee75e99a924b/beea1c91-3d42-4a92-b871-27082af1144e/_default`. The host runs `dist/worker.js` in a worker process and serves `dist/ui/` to the browser at `/_plugins/rukoz.throughput-panel/ui/`.
- The worker scrapes each enabled server on this Mac's loopback (the browser cannot reach it): server 1 `http://127.0.0.1:18081/metrics` (ssh tunnel `com.drukoz.llm-metrics-tunnel` to hpcserver's vLLM, no key); server 2 the A9 Mega `http://127.0.0.1:18082/metrics` (launchd forwarder `com.drukoz.llm-forward-a9` to port 8081 on the A9, behind Caddy, needs `Authorization: Bearer <key>`: the A9's read-only metrics key, a Paperclip secret picked in `server2Token`; there is no built-in key). The A9 runs Gufo (an NPU fork of llama.cpp, systemd unit `gufo-serve`), which serves llama.cpp-style `llamacpp:*` metrics with no labels, plus `llamacpp:kv_cache_usage_ratio` and `llamacpp:prompt_tokens_cached_total`.
- The panel reads vLLM, llama.cpp and Splash metrics, told apart by their metric names (`vllm:…` / `llamacpp:…` / `splash_…`); the A9 runs llama.cpp, whose `/metrics` exists only with `--metrics`.
- Server 3 is the M5U: a Mac Studio on the LAN that since 2026-11-17 runs **Splash 1.7.0** (Homebrew, launchd `com.local.splash` on the M5U), serving Swift-1.5 Q6_K with a DFlash2 draft model, 128K context, on port 8081. This Mac reaches it at `http://127.0.0.1:18083` through the launchd forwarder `com.drukoz.llm-forward-m5u`, which is also how Paperclip's agents reach it (`paperclip/swift15-oq8e`). Splash wants `Authorization: Bearer <key>` on every route except `/health` (401 without it); the key is a Paperclip secret picked in `server3Token`, and there is no built-in key. The plugin reads `GET /metrics` (RUK-2789): Prometheus text with `splash_*` names and no per-model labels, so it is one model entry, named from `GET /v1/models` (`data[0].id`, `local/swift15-q6_k`) once a minute, as for llama.cpp. Splash also serves `/status` (JSON, `schema_version` 8) and `/health`; it has no `/v1/metrics`, `/stats`, `/slots` or `/api/metrics`. How each `splash_*` metric maps to `MetricsSample` is in `splashSample`'s JSDoc in `src/metrics/parse.ts`. Splash has no decode-time counter, so per-request tok/s reads `—` for the M5U.
- Until 2026-11-17 the M5U ran **oMLX** 0.7.4.dev1 (RUK-949), which has no `/metrics`. `src/metrics/omlx.ts` reads its two JSON routes, `GET /admin/api/activity` (live per-request rows; admin auth, so oMLX's **main** key) and `GET /api/status` (session totals), and turns them into counters. Nothing runs oMLX now; the reader is kept (RUK-2789) so server 3 can be pointed back at an oMLX activity URL if the M5U returns to oMLX. A body that parses as oMLX activity is read that way whatever the URL. Don't extend it.
- The host starts the worker with a minimal environment (`PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`; no `HOME`). Anything the worker spawns gets an absolute executable path and an explicit environment.
- The Claude check spawns the Claude Code CLI, `/opt/homebrew/bin/claude` by default (setting `claudePath`), with the account's token in `CLAUDE_CODE_OAUTH_TOKEN` and a private folder as `HOME` and `CLAUDE_CONFIG_DIR` (`/tmp/rukoz-throughput-panel/claude-check`: no `TMPDIR`, so `os.tmpdir()` is `/tmp`).
- Plugin settings are per company on this host. The worker starts with an empty config, and `ctx.config.get()` without a company id fails in `setup`; on a full start the host replays each company's saved settings through `onConfigChanged(config, { companyId })`, so that is where the worker learns them. The dev watcher's restart (`plugin-dev-watcher: file change detected, restarting worker`, on any change under `dist/`) does **not** replay them, so the worker also loads them with `ctx.config.get(companyId)` on the first `"servers"` or `"plan-probe"` request that carries `companyId` (RUK-1545).
- The Claude token settings are secret fields: `format: "secret-ref"` and no `type`, because the settings page shows a secret picker only for that format and the host's Ajv check rejects the stored `{ type: "secret_ref", ... }` object under `type: "string"`. This host resolves a plugin's secret only with `{ companyId }`, which the worker keeps from `onConfigChanged`, and it refuses a host call made in a request that has already ended (`services/plugin-secrets-handler.js` and the SDK's `host-client-factory.js` in the installed Paperclip). So checks start through `runOutsideInvocation` (an `AsyncLocalStorage.snapshot()` taken at module load), never straight from a data handler. `authToken` is still a plain string field; a secret reference there would fail.
- The panel's UI code runs inside the Paperclip page with the user's board session. It can call Paperclip's HTTP API (`/api/...`) directly with `fetch(url, { credentials: "include" })`. The worker cannot: it has no board session.

## Layout

```
src/manifest.ts        plugin manifest: id, capabilities, config schema, the appShellOverlay slot
src/worker.ts          worker: config resolution, poll loop, the "throughput" data handler
src/servers.ts         per-server settings and poller (RUK-869)
src/snapshot.ts        builds the ThroughputSnapshot the UI reads
src/types.ts           worker-to-UI contract (MetricsSample, ThroughputSnapshot, ...)
src/windows.ts         the 1m / 5m / 15m average windows
src/metrics/           Prometheus text parser (vLLM, llama.cpp, Splash) and the rate window; omlx.ts turns oMLX's JSON into counters (RUK-949, legacy)
src/ui/index.tsx       the ThroughputPanel component (the whole panel)
src/ui/format.ts       display formatters; src/ui/window.ts window helpers; src/ui/Sparkline.tsx
src/usage/             Claude plan usage (RUK-249): contract, meter selection, usage-check client, run-log parser and reader, stored check state, view
src/usage/probe-*.ts   the per-account Claude check (RUK-518): contract, output parser, CLI runner, controller, view
src/ui/PlanUsageSection.tsx  one Claude section; src/ui/usePlanUsage.ts (RUK-249) and src/ui/useProbeUsage.ts (RUK-518) feed it
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
| `npm run harness` | bundles the real panel into `scripts/mobile-harness/`'s static page and saves phone (500×844, touch emulated) and desktop screenshots to `scripts/mobile-harness/out/` (git-ignored) with headless Chrome | four `<name>.png: <bytes> bytes` lines, exit 0 |

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
- `@paperclipai/plugin-sdk` 2026.1023.0. The host now runs 2026.1106.0. The routes and response fields this plugin reads were last rechecked on 2026.1029.0-nightly.1, on 2026-10-30, not yet on 2026.1106.0. Do not upgrade the SDK as a side effect of other work.
- Paperclip API shapes this plugin reads are copied into `src/usage/types.ts` from `@paperclipai/shared` 2026.1023.0. The fields the plugin reads were unchanged in 2026.1029.0-nightly.1, which only added a `github` provider and an optional `environmentId`; 2026.1106.0 has not been compared.
- Claude Code 2.1.318, installed by Homebrew at `/opt/homebrew/bin/claude` (it moves on `brew upgrade`). The check's flags were checked against its `--help` on 2026-11-04. Do not use `--bare`: it never reads OAuth tokens, only `ANTHROPIC_API_KEY`.

## Branches and delivery

- GitHub remote `origin`: `drukoz/Paperclip-Throughput-Panel-Plugin` (private), default branch `main`. Never push to `main` and never force-push; changes reach `main` only through a pull request the user merges.
- Pull request #1 merged `feature/ruk-19-throughput-panel` into `main` on 2026-11-12. From RUK-1950 on, each parent task's branch is cut from `origin/main` and gets its own pull request into `main`, which the user reviews and merges.
- The live plugin is built from `feature/ruk-19-throughput-panel`, which is checked out in the `_default` checkout.
- Each parent task gets its own branch, for example `feature/ruk-1950-plan-reset-time`. Each subtask works in its own git worktree, on a branch named `<feature-branch>-RUK-<n>`. Since the project workspace became the GitHub repository (2026-11-14), Paperclip clones it as `Paperclip-Throughput-Panel-Plugin` next to `_default` and puts each subtask's worktree under that clone's `.paperclip/worktrees/` (git-ignored). Commit on the worktree's current branch; never switch or create branches.
- Delivered on 2026-11-04: `feature/ruk-518-usage-probe` (RUK-518, which carried RUK-249's rework `feature/ruk-249-usage-from-runs`). Later RUK-518 work branches from `feature/ruk-19-throughput-panel`.
- At delivery the CTO merges the feature branch into `feature/ruk-19-throughput-panel` in `_default` and runs `npm run build` there. The user then reloads the Paperclip page, and, when the worker changed, disables and re-enables the plugin once.

## Dangers

- The `_default` checkout is the live plugin. `npm run build` there deletes and rewrites `dist/`, which the host serves to the user's browser. Only the CTO builds, commits or changes branches in `_default`, and only at delivery.
- Never restart Paperclip or touch the launchd agents in `~/Library/LaunchAgents`: a restart kills every agent run in progress.
- Do not count on the host's dev watcher to restart the worker after `npm run build` in `_default`. It did on 2026-11-12 at 03:29 (and the panel then lost its settings), but not after the 11:13 build that day. Check the worker's start time with `ps -axo pid,lstart,command | grep _default/dist/worker.js`. If the worker does restart, the panel loads its settings again on its next request. A plugin disable/enable or a Paperclip restart, both done by the board operator, always restarts it.
- Every call to `GET /api/companies/:companyId/ai-connections/:connectionId/usage` reads the stored Claude credential, writes a row to Paperclip's secret access log, and asks Anthropic, which rate-limits it hard: on 2026-10-30 the panel's first checks all came back 429. The panel calls it on its own at most every 15 minutes (30 after a 429) and shares that schedule across tabs through `localStorage`; ↻ forces a call only when the last attempt is at least 5 minutes old. Do not add another caller or shorten either interval; read numbers from agent run logs instead.
- Run logs hold full agent transcripts. The panel reads only the ends of the 3 newest Claude runs' logs (`GET /api/heartbeat-runs/:runId/log?offset=…&limitBytes=…`), and reads a run again only when its size has changed. The first read starts 256 KiB before the run's `lastOutputBytes` and asks for 512 KiB, because Paperclip saves `lastOutputBytes` only once a minute and the file can be ahead of it. Claude Code writes a `rate_limit_event` only at a run's first response and when the 5-hour figure moves by a whole percent, so when that read finds none the reader steps back at most 3 times, 512 KiB each plus a 64 KiB overlap (576 KiB per request), never below the size an earlier read already searched: about 1.75 MiB before `lastOutputBytes` in all. On 2026-10-30 the farthest last event in 14 finished CTO runs was 0.56 MB before the end. It keeps only the parsed `rate_limit_event` numbers. Never display, store or send other log content, and never read whole logs in a poll.
- Each Claude check spends a little of that account's Claude usage. Checks run only when the panel asks for the "plan-probe" data with `active: true` (the panel is expanded and the tab visible), one at a time, at most every `claudeCheckMinutes` per account. Never add a timer of the worker's own, a retry loop, or a second caller.
- A Claude token is resolved for each check, passed only in the child process's environment, and dropped. Never log, store, return or display it, and never put it in an error message.
- Tests never run the real `claude`; they use the fake CLI in `src/usage/fixtures/`. A test that ran it would spend real usage.
- On timeout the check kills the child's whole process group (`detached: true`, then `process.kill(-pid, "SIGKILL")`). Paperclip's own Claude CLI probe once leaked processes until the server ran out of memory (paperclipai/paperclip#8970).
- For a Paperclip sign-in (`claude setup-token`) the AI-connection usage route always answers 403 `permission_denied` (paperclipai/paperclip#18911): the check is the only source for those accounts.
- The `/api/plugins` routes need a board instance-admin credential; an agent key gets `403`. Do not loop on them.
- Never commit a token, key or secret value, including in test fixtures.
- The M5U's `server3Token` is Splash's API key, which also allows inference. The plugin sends it only with `GET`, only to the configured server-3 URL (`/metrics`) and the same server's `/v1/models` (the model name, at most once a minute), and to no other route. Never add a POST or another route, and never log, store or display the key. If server 3 is pointed at a legacy oMLX activity URL, the key must be oMLX's main key, which also allows every oMLX admin action, and the oMLX reader also GETs that server's `/api/status`.
- There is no exception. The A9 Mega's read-only metrics key was hard-coded in `src/servers.ts` from RUK-869 until RUK-2003 removed it before the repository went public; it is now a Paperclip secret picked in `server2Token`, like every other key. Caddy on the A9 accepts it only for `/metrics` and `/v1/models`. It lives on the A9 as `A9_METRICS_KEY` in `/etc/caddy/a9-llm.env` (restart Caddy while Gufo is idle after changing it). Never log it or put it in an error message, a fixture or a test.
- This repository is meant to be public: never commit a real LAN address, internal hostname or URL of our machines (code and docs use the `127.0.0.1` forwarder ports; tests use made-up names such as `m5u.local` or `10.0.0.9`).
