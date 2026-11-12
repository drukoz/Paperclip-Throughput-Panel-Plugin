# Model Throughput Panel

## What it is

A Paperclip plugin that shows a live tokens/sec readout for every model on each of up to three local model servers — each running vLLM, llama.cpp or **oMLX** — as a small floating panel in the Paperclip UI. The third is the M5U: a Mac on the LAN running oMLX 0.7.4.dev1 ([github.com/jundot/omlx](https://github.com/jundot/omlx)), serving `swift15-oq8e`, which this Mac reaches at `http://127.0.0.1:18083` through the launchd forwarder `com.drukoz.llm-forward-m5u` (→ `192.168.1.183:8081`). A worker on the Paperclip host reads Prometheus metrics from vLLM and llama.cpp, and oMLX's JSON activity and status routes, and tells the formats apart by their metric names (`vllm:…` / `llamacpp:…`) or by an oMLX activity body; the panel's kind label for that server reads `oMLX`. The plugin id is `rukoz.throughput-panel`.

oMLX has no Prometheus `/metrics` endpoint — it answers 404 — so the worker reads two JSON routes instead: `GET /admin/api/activity`, the live rows of every request being prefilled or generated, per loaded model, and `GET /api/status`, the session totals of prompt, completion and cached tokens. oMLX adds a request's tokens to those totals only when the request finishes, so the worker computes live tok/s from the activity rows (each request's growing `generated_tokens`) and uses the totals for the tokens a request produced after the last poll, and for the cache hit rate.

The panel has one section per configured server, headed by the server's label, and inside it one block per model the server reports. The collapsed pill shows the total generation tok/s summed across every server.

Each model block shows:

- Generation and prompt tok/s, with an average over a selectable window (1m / 5m / 15m) that counts only the time the server was producing tokens
- Per-request tok/s — the speed a single agent sees while decoding (decode tokens divided by decode time)
- Time to first token (TTFT), the mean over requests in the window (vLLM only)
- Requests running and waiting
- KV cache usage (vLLM, and llama.cpp servers that report it, such as the A9's Gufo; not oMLX)
- Prefix-cache hit rate (vLLM, llama.cpp servers that report it, such as the A9's Gufo, and oMLX)
- MTP / draft (speculative decoding) acceptance rate (not oMLX)
- A generation tok/s sparkline covering the selected window
- The selected window, remembered across reloads in `localStorage`
- An explicit unreachable state, per server, when that server's endpoint cannot be reached
- Claude plan usage for your default Claude subscription: how much of the current 5-hour session, the weekly limit and the weekly Fable limit is used, with the reset time on hover (on a touch screen, tap the bar)

### On a phone

Paperclip places the panel in its overlay container, so on screens narrower than 768 px the pill and the card sit above Paperclip's bottom navigation instead of covering it, and on a desktop the panel stays 16 px from the bottom-right corner. On a phone the expanded card is no taller than the visible screen above the navigation, and it scrolls inside itself without scrolling the page behind it. On a touch screen (`pointer: coarse`) the window buttons, the collapse and ↻ buttons are at least 36 px tall, and each Claude bar is a button: tap it to show or hide its reset time and the age and source of its reading. A desktop with a mouse looks the same as before. `npm run harness` renders the real panel inside a copy of Paperclip's overlay container and bottom navigation and saves phone-size (touch) and desktop screenshots to `scripts/mobile-harness/out/`.

## How it works

The worker polls the metrics endpoint every 5 s by default (configurable via `pollIntervalMs`, clamped to 1–60 s), keeps a 15-minute window of samples — 15 minutes is the longest selectable average window — and computes rates from counter deltas between samples. The UI is an `appShellOverlay` slot that reads a snapshot from the worker over the plugin bridge every 5 s. The panel defaults to the 5m window; it slices the snapshot's sparkline to the selected window client-side, so switching windows needs no round trip to the worker. The windowed average divides tokens by the time spent producing them: intervals in which a counter did not move are left out of both the token total and the elapsed time, so an idle stretch leaves the average at the rate the server last sustained instead of pulling it toward zero, until the window retains no active interval at all and the average reads `0`. The large readout and the sparkline are unfiltered, so idle time still shows up as 0 tok/s there.

Polling happens worker-side because the browser cannot reach `127.0.0.1:18081` on the Paperclip host — the endpoint is bound to the host's loopback, so only a process running on that host can scrape it.

The Claude plan section is read by the panel itself, not by the worker, with your signed-in Paperclip session; the plugin never sees a Claude credential. It has two sources. **Agent runs:** Claude Code writes the account's 5-hour and weekly utilization into every Claude agent run's log (a `rate_limit_event` line). While the card is expanded and the tab is visible, the panel reads the end of the newest Claude runs' logs every 60 seconds (`GET /api/companies/:companyId/agents`, `GET /api/companies/:companyId/heartbeat-runs?agentId=…`, `GET /api/heartbeat-runs/:runId/log`), reading only bytes it has not read before. This asks nothing of Anthropic. **Usage check:** `GET /api/companies/:companyId/ai-connections` finds your default Claude subscription connection, then `GET /api/companies/:companyId/ai-connections/:connectionId/usage?grantId=…` asks Anthropic for that account's usage. It is the only source of the Fable meter. It runs at most every 15 minutes (30 after Anthropic rate-limits it), and the schedule and the last good answer are kept in `localStorage`, so a reload or a second tab does not check again. Each usage check reads the connection's stored credential, which Paperclip records in that secret's access log. For each meter the panel shows the newer of the two readings; hover a bar to see how old it is and where it came from. ↻ re-reads the runs at once, and forces a usage check only when the last one is at least 5 minutes old.

## Build

Requires Node >= 24.11.

```bash
npm install
npm run typecheck
npm test
npm run build
```

- `npm run typecheck` — `tsc --noEmit`, no type errors expected.
- `npm test` — runs on the built-in `node:test` runner; no extra test framework is installed.
- `npm run build` — bundles with esbuild. It lands three artifacts in `dist/`:
  - `dist/worker.js` — the worker entrypoint
  - `dist/manifest.js` — the compiled plugin manifest
  - `dist/ui/index.js` — the UI bundle

`dist/` is gitignored and rebuilt locally; install from a checkout that has been built.

## Install on this instance

**This step needs a board operator who is an instance admin.** An agent API key cannot call the install route — only board-level instance-admin rights work.

1. Build the plugin in the checkout (see [Build](#build)).
2. Install it from the local checkout, passing the absolute path with `isLocalPath: true`:

   ```bash
   curl -s -X POST http://127.0.0.1:3100/api/plugins/install \
     -H "Authorization: Bearer <BOARD_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"packageName":"<absolute path to this repo>","isLocalPath":true}'
   ```

3. Confirm it is installed and enabled (this route also needs the board credential, same as the install call):

   ```bash
   curl -s http://127.0.0.1:3100/api/plugins \
     -H "Authorization: Bearer <BOARD_API_KEY>"
   ```

   The list should include `rukoz.throughput-panel` as enabled.

## Configure

Configuration is company-scoped. There are two ways to set it:

1. **Paperclip UI** — the plugin registers an instance-settings form generated from the manifest's `instanceConfigSchema`; edit it in the Paperclip UI.
2. **Config route**:

   ```bash
   curl -s -X POST http://127.0.0.1:3100/api/plugins/rukoz.throughput-panel/config \
     -H "Authorization: Bearer <BOARD_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"companyId":"<companyId>","configJson":{"metricsUrl":"http://127.0.0.1:18081/metrics"}}'
   ```

### Config keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server1Label` | string | `hpcserver` | Server 1's label, shown in the panel. |
| `metricsUrl` | string | `http://127.0.0.1:18081/metrics` | Server 1's Prometheus `/metrics` endpoint (vLLM or llama.cpp). |
| `authToken` | secret | *(none)* | Server 1's optional bearer token, sent as `Authorization: Bearer <token>`. hpcserver needs none. |
| `modelName` | string | *(none)* | Server 1's model filter: show only this `model_name`. Blank shows every model the server serves. |
| `server2Label` | string | `A9 Mega` | Server 2's label, shown in the panel. |
| `server2MetricsUrl` | string | `http://127.0.0.1:18082/metrics` | Server 2's Prometheus `/metrics` endpoint — the A9 Mega (Strix Halo). Save it empty to hide this server. |
| `server2Token` | secret | *(built-in A9 metrics key)* | Server 2's bearer token. Leave it empty for the A9 Mega: the plugin has its read-only metrics key built in. |
| `server3Label` | string | `M5U` | Server 3's label, shown in the panel. |
| `server3MetricsUrl` | string | `http://127.0.0.1:18083/admin/api/activity` | The M5U's oMLX activity route; save it empty to hide this server. |
| `server3Token` | secret | *(none)* | oMLX's main API key; no built-in key. |
| `pollIntervalMs` | number | `5000` | Poll interval in milliseconds; minimum 1000, clamped to 60000. |
| `claudeAccount1Label` … `claudeAccount3Label` | string | *(none)* | Shown in the panel as "Claude · <label>"; blank means "Account <n>". |
| `claudeAccount1Token` … `claudeAccount3Token` | secret | *(none)* | A Claude Code token for that account, from `claude setup-token`, stored as a Paperclip secret. A slot without a token is ignored. A raw value pasted instead stays in these settings as plain text. |
| `claudePath` | string | `/opt/homebrew/bin/claude` | Absolute path of the Claude Code CLI the checks run. |
| `claudeCheckMinutes` | number | `15` | Minutes between checks of one account; 5 to 120. |

A server slot is enabled when its metrics URL, after defaults, is a non-blank string: server 1 is always on; server 2 is on unless `server2MetricsUrl` is saved as an empty string; server 3 is on unless `server3MetricsUrl` is saved as an empty string.

The current hpcserver endpoint answers with HTTP 200 and no `Authorization` header, so `authToken` is optional — the plugin sends a token to a server only when that server has one configured. The A9 Mega is behind Caddy, which answers 401 to every request without `Authorization: Bearer <key>`, so the plugin sends its built-in read-only A9 metrics key there (Caddy accepts that key only for `/metrics` and `/v1/models`). `server2Token`, when set, replaces it.

### The token

Resolution precedence is: **operator config → environment variable → none**. If `authToken` is unset in the company config, the worker falls back to `THROUGHPUT_METRICS_TOKEN`; if that is also unset, no `Authorization` header is sent.

For the config route, the `authToken` value may be either a literal string or a Paperclip secret reference object:

```json
{ "type": "secret_ref", "secretId": "<uuid>" }
```

The secret reference is the recommended form. The plugin resolves it at call time for each poll, keeps the resolved value in memory only, and never caches or logs it. **Never commit a token, API key, or secret value to this repository.** The one exception is the A9 Mega's read-only metrics key in `src/servers.ts` (see `CLAUDE.md`).

Each server has its own token field — `authToken` for server 1, `server2Token` for server 2, `server3Token` for server 3 — and each is a secret field, so the settings page shows a secret picker for it. The A9 Mega needs nothing here: with **Server 2: token** empty and the default URL, the plugin sends its built-in read-only metrics key. Set the field only to use a different key; if you point server 2 at another URL, the built-in key is not sent.

The M5U is the opposite: **Server 3: token** has no built-in key, and it must be oMLX's **main** API key. oMLX's activity route is an admin route, so the main key is required there and a sub-key is answered `401`; `/api/status` accepts any key. Pick the Paperclip secret the M5U AI connection uses, if that secret holds oMLX's main key, or press **+** to store the main key as a new secret. The main key also allows inference and every oMLX admin action — unloading models, restarting the server, changing settings — so the plugin limits it narrowly: it sends it only with `GET` to the two oMLX routes on that server, the configured `server3MetricsUrl` and the same server's `/api/status`, and never logs, stores or shows it.

### Claude accounts

With at least one Claude account set, the expanded panel shows one **Claude · <label>** section per account instead of the single **Claude plan** section. For each account the worker runs one tiny Claude Code request (`claude -p` with Haiku, a one-word reply, no tools, no MCP servers, nothing saved) and reads the usage report Claude Code prints with it. A check runs only while the panel is expanded and its tab is visible, at most every `claudeCheckMinutes` minutes per account, one account at a time. Each check spends a small amount of that account's Claude usage. Claude Code runs with a private config folder, `/tmp/rukoz-throughput-panel/claude-check` (the worker has no `TMPDIR`), not your own `~/.claude`.

To set up an account:

1. In Terminal, run `claude setup-token` and sign in with that account in the browser window it opens. It prints a long-lived token.
2. In **Claude account N: token**, press **+** next to the secret list. In **Create new secret**, give the secret a name (for example `claude-token-1`), paste the token as its value, and press **Create & bind**. Paperclip stores it encrypted, and the worker reads it for each check. **Or paste a raw value** also works, but keeps the token in the plugin's settings as plain text.
3. Set **Claude account N: label**, for example the account's email address, and save the settings.
4. A build that changes the worker reaches it only after you disable and re-enable the plugin once (`paperclipai plugin disable rukoz.throughput-panel`, then `paperclipai plugin enable rukoz.throughput-panel`). A page reload alone loads only the panel.

What the bars can show: Anthropic reports only the window closest to its limit. Since 31 October 2026 that has usually been the weekly window, so the 5-hour bar shows "—" with the note "Anthropic reports only the weekly limit right now". Fable's weekly window is not reported for these tokens, so its row is hidden. Hover a bar for its reset time and age.

| Message under an account | Meaning |
| --- | --- |
| No token: set this account's token in the plugin settings | The token setting is empty, or its secret cannot be read. |
| Could not start Claude Code: … | `claudePath` is wrong, or the CLI is not installed. |
| Claude Code did not answer in time | The check ran past 60 seconds and was stopped. |
| Claude Code: … | Claude Code's own error, for example a revoked token. |
| Limit reached: Claude is blocked on this account until the reset | The account is at its limit. |
| Last check failed: … | The newest check failed; the bars show the one before. |

The worker resolves each token for one check, passes it only to that Claude Code process, and never stores, logs or shows it.

### Environment variables (dev server only)

The worker reads these variables (server 1 only):

| Variable | Overrides |
| --- | --- |
| `THROUGHPUT_METRICS_URL` | `metricsUrl` |
| `THROUGHPUT_METRICS_TOKEN` | `authToken` |
| `THROUGHPUT_MODEL_NAME` | `modelName` |

They are **not** delivered by the Paperclip host. The host builds each plugin worker's environment from scratch (a minimal set: `PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`, and a couple of deployment-mode variables) and deliberately does not forward its own `process.env` into the worker. So for an installed plugin these variables are always empty, and they are only useful when running the worker outside the host, such as under the plugin SDK dev server.

For an installed plugin, **operator config is the only supported way** to set `metricsUrl`, `authToken`, and `modelName` — see [Configure](#configure). The servers 2 and 3 keys (`server2MetricsUrl`, `server2Token`, `server3MetricsUrl`, `server3Token`) have no environment override at all: they are set in the config only.

## Verify

Run these on the Paperclip host. The two `/api/plugins` routes below need a **board instance-admin credential** (`<BOARD_API_KEY>`); the direct `18081/metrics`, `18082/metrics` and `18083` checks in step 4 do not. The A9 (`18082`) check needs the A9 Mega's key in your own shell, not a board credential; the M5U (`18083`) checks need oMLX's main key the same way, and its `/health` needs no key at all.

1. The plugin is installed and enabled:

   ```bash
   curl -s http://127.0.0.1:3100/api/plugins \
     -H "Authorization: Bearer <BOARD_API_KEY>"
   ```

2. The worker is healthy:

   ```bash
   curl -s http://127.0.0.1:3100/api/plugins/rukoz.throughput-panel/health \
     -H "Authorization: Bearer <BOARD_API_KEY>"
   ```

   A healthy worker reports `ok` (with a `metrics streaming` message once it is receiving samples).

3. The panel appears bottom-right on any signed-in Paperclip page, and its status dot turns green.

4. Check the data source directly, without the plugin at all. Server 1 (hpcserver, no key):

   ```bash
   curl -s http://127.0.0.1:18081/metrics | grep vllm:generation_tokens_total
   ```

   Server 2 (the A9 Mega, behind Caddy, needs the key). Type the key into your own shell's `A9_KEY` variable — never paste it as plain text into a chat, a file, or anywhere it is logged (in the plugin settings it goes in only through the secret picker of **Server 2: token**):

   ```bash
   read -rs A9_KEY   # type the A9 key, press Enter; it stays in your shell only
   curl -s -H "Authorization: Bearer $A9_KEY" http://127.0.0.1:18082/metrics | grep -E '^(vllm|llamacpp):' | head
   ```

   The M5U (oMLX; `/health` needs no key, the two JSON routes need oMLX's main key). Type the key into your own shell's `M5U_KEY` variable — never paste it as plain text into a chat, a file, or anywhere it is logged (in the plugin settings it goes in only through the secret picker of **Server 3: token**):

   ```bash
   curl -s http://127.0.0.1:18083/health
   read -rs M5U_KEY   # type oMLX's main key, press Enter; it stays in your shell only
   curl -s -H "Authorization: Bearer $M5U_KEY" http://127.0.0.1:18083/admin/api/activity | head -c 600; echo
   curl -s -H "Authorization: Bearer $M5U_KEY" http://127.0.0.1:18083/api/status | head -c 600; echo
   ```

   Expected: `/health` answers `{"status":"healthy","default_model":"swift15-oq8e",...}`; the activity route answers JSON starting `{"active_models":{"models":[{"id":"swift15-oq8e",...`; `/api/status` answers JSON with `"total_completion_tokens"`.

   If these return lines, the endpoint is up and the panel should follow within a few seconds.

## Troubleshooting

The `/api/plugins` HTTP routes require a **board instance-admin credential**; a bare `curl` does not carry one and is answered with `403 {"error":"Board access required"}`. The supported way to reach them is the `paperclipai plugin` CLI, which carries the operator's own credential. Do not retry these routes with bare `curl`. Run these on the Paperclip host (the plugin key for this plugin is `rukoz.throughput-panel`):

```bash
paperclipai plugin list                          # list installed plugins
paperclipai plugin inspect rukoz.throughput-panel   # full details for this plugin
paperclipai plugin health rukoz.throughput-panel    # get plugin health
paperclipai plugin logs rukoz.throughput-panel      # get plugin logs
paperclipai plugin enable rukoz.throughput-panel    # enable a disabled/errored plugin
paperclipai plugin disable rukoz.throughput-panel   # disable a running plugin without uninstalling
paperclipai plugin target                         # show which instance plugin commands talk to
```

The CLI only carries a board credential once it has been connected as a board operator. If these commands also answer `403 Board access required`, the CLI is falling back to an agent key (or no key); connect it once and retry:

```bash
paperclipai connect --persona board
```

- **A server's section shows "Model server unreachable".** That server's scrape failed. Check its endpoint directly (server 1: `curl -s http://127.0.0.1:18081/metrics`; the A9 Mega: the `18082/metrics` check in [Verify](#verify); the M5U: `curl -s http://127.0.0.1:18083/health`), its configured URL (`metricsUrl`, `server2MetricsUrl`, `server3MetricsUrl`), and its token. See the status-code notes below.
- **A server's section shows `HTTP 401`.** That server's bearer token is missing or wrong. Set the server's token field (`authToken`, `server2Token`, or `server3Token`) in the plugin settings; the A9 Mega needs `server2Token` on every request. The M5U says `HTTP 401 Unauthorized — set this server's token in the plugin settings` when **Server 3: token** is empty: set it. It says `HTTP 401 Unauthorized — oMLX's activity route needs the server's main API key; a sub-key reaches only /api/status` when a sub-key or a wrong key is set: replace it with oMLX's main API key. If the token is set and the M5U still says 401 right after a plugin restart, opening the panel page once reloads the settings within a minute, and saving the plugin settings unchanged also does.
- **The M5U block shows tok/s but no cache hit rate.** Its `/api/status` call failed: the live tok/s comes from the activity route and keeps working, so only the cache hit rate reads empty. Run the `/api/status` check in [Verify](#verify), and check **Server 3: token** — any key reaches that route.
- **A llama.cpp server answers `HTTP 404` or `HTTP 501`.** `llama-server` publishes `/metrics` only when it was started with `--metrics`; without that flag the path does not exist. A 404 can also mean the Caddy in front of the server does not forward `/metrics`. Start llama.cpp with `--metrics`, and check the Caddy route.
- **A llama.cpp server answers `HTTP 400 "model name is missing"`.** The server runs in llama.cpp router mode (several models behind one endpoint), which is not supported yet.
- **Panel shows "Model server unreachable" with an error mentioning "private/reserved ranges".** The worker is routing through the host's guarded HTTP client instead of scraping directly; that is the bug fixed in RUK-52, so make sure the installed build includes it.
- **Panel shows "Panel unavailable".** The worker itself is not responding. Check the logs for worker errors with `paperclipai plugin logs rukoz.throughput-panel`, then restart it with a disable/enable cycle:

  ```bash
  paperclipai plugin disable rukoz.throughput-panel
  paperclipai plugin enable rukoz.throughput-panel
  ```
- **The Claude plan section says "No Claude subscription connected" or asks you to reconnect.** Open AI connections in Paperclip and connect or reconnect your Claude subscription. The section follows on its next usage check, at most 15 minutes later; ↻ checks at once if the last check is at least 5 minutes old.
- **The Claude plan note says Anthropic is rate-limiting usage checks.** The 5h and weekly bars keep updating from agent runs; only the Fable bar waits for the next successful check, at most 30 minutes later. Nothing needs doing.
- **The model server restarted and the panel stopped updating.** The worker recovers on its own: a failed poll is caught, `lastError` is set, and the next interval retries — the poll loop is never torn down by a failed scrape. A counter reset (which is what a vLLM restart looks like, because the cumulative counters drop) clears the sample window, so rates read `—` for one poll and refill within about 10 s (two poll cycles); this is the same behaviour noted in [Scope and limits](#scope-and-limits) below. If the plugin **worker process** was replaced (a host restart, or the worker being respawned), an already-open browser tab can keep showing the snapshot it last received — **reload the browser page** to re-establish the UI data bridge. Reloading the page is the first thing to try, and it is cheaper than a disable/enable cycle. Only if a page reload does not help is a disable/enable cycle warranted, and the logs (`paperclipai plugin logs rukoz.throughput-panel`) are the place to look.
- **Panel shows `—` for everything.** Fewer than two samples are in the window yet, so no rate can be computed. Wait about 10 s (two poll cycles) and it should fill in.
- **Selecting 15m right after the worker starts shows a smaller average.** The worker averages over whatever history it has retained so far, so before 15 minutes have accumulated the readout covers that shorter span — the average's tooltip says how many seconds of history it has. The graph fills in over the following minutes as more samples arrive.
- **Server 1's section is empty.** If `modelName` names a `model_name` the server does not serve, the worker logs a `no vllm metrics for model "..."` error and the section stays empty. Blank `modelName` now shows every model the server serves — the old `swift-1.5` default is gone, so leave it blank to see all of them.

## Project layout

```
src/
  manifest.ts          Plugin manifest: id, entrypoints, capabilities, config schema, UI slot
  manifest.test.ts     Tests for the manifest (overlay slot, capabilities)
  worker.ts            Worker: config resolution, poll loop, token resolution, health, snapshot registration
  snapshot.ts          Builds the ThroughputSnapshot served to the UI from the sample window
  snapshot.test.ts     Tests for snapshot building
  types.ts             Shared types: MetricsSample, ThroughputSnapshot, rates, sparkline points
  windows.ts           Selectable window contract: the 1m / 5m / 15m keys and their lengths in ms
  metrics/
    parse.ts           Prometheus text-format parser and vLLM sample selector
    parse.test.ts      Tests for the parser and selector
    rates.ts           15-minute ThroughputWindow; rates computed from counter deltas
    rates.test.ts      Tests for the window and rate math
  ui/
    index.tsx          ThroughputPanel widget rendered in the appShellOverlay slot
    format.ts          Display formatters for rates, percentages, counts, and ages
    format.test.ts     Tests for the formatters
    window.ts          Slices the snapshot to the selected window; captions and average tooltip
    Sparkline.tsx      SVG sparkline for the generation rate over the selected window
    PlanUsageSection.tsx  The "Claude plan" section of the expanded card
    usePlanUsage.ts    Hook that polls Claude plan usage while the card is expanded
  usage/
    types.ts           Claude plan usage contract: Paperclip response subsets, meters, view states
    select.ts          Picks the 5-hour, weekly and Fable meters out of Paperclip's usage limits
    select.test.ts     Tests for the meter selection
    client.ts          Fetches the default Claude subscription's usage from Paperclip's API
    client.test.ts     Tests for the client, using a fake fetch
    run-events.ts      Parses Claude Code's rate_limit_event lines out of a run-log slice
    run-events.test.ts Tests for the run-log parser
    run-client.ts      Reads the newest Claude agent runs' log tails through Paperclip's API
    run-client.test.ts Tests for the run-log reader, using a fake fetch
    stored.ts          The usage-check state kept in localStorage, and the check schedule
    stored.test.ts     Tests for the stored state
    view.ts            Merges agent-run and usage-check readings into the section's view state
    view.test.ts       Tests for merging readings and the view state
```

## Scope and limits

- The panel sits in the bottom-right corner, where Paperclip's overlay container puts it; it is not draggable or resizable. On a phone it stays a 232 px corner card rather than going full width.
- The prefix-cache hit rate and MTP acceptance rate are cumulative since the model server started; the average-window selector does not affect them.
- oMLX (the M5U) publishes no TTFT, KV cache or MTP numbers, so those read `—` in its blocks, and its prefix-cache hit rate is server-wide — `total_cached_tokens / total_prompt_tokens` — not per model.
- A counter reset (a model server restart) clears the sample window, so rates read `—` for one poll afterwards until two fresh samples accumulate.
- The windowed average skips intervals with no tokens, so it is an average of active throughput, not of wall-clock time; a window in which nothing ran at all reads `0`. The instantaneous readout and the sparkline are not filtered this way.
- Claude plan usage is shown only in the expanded card, not in the collapsed pill.
- The Fable row comes only from Anthropic's usage check: it shows `—` until a check succeeds, or when the account has no Fable window. The 5h and weekly rows are as fresh as the newer of the last Claude call an agent made through Paperclip and the last successful usage check. A bar whose window has reset since its reading shows `—`.
- With several Claude subscriptions connected, the section shows your default one, as set in Paperclip's AI connections.
