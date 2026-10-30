# Model Throughput Panel

## What it is

A Paperclip plugin that shows a live tokens/sec readout for the local vLLM model server, as a small floating panel in the Paperclip UI. It polls the server's Prometheus metrics endpoint from a worker on the Paperclip host and renders generation and prompt throughput, request counts, cache stats, and a generation tok/s graph over a selectable window. The plugin id is `rukoz.throughput-panel`.

The panel shows:

- Generation and prompt tok/s, with an average over a selectable window (1m / 5m / 15m) that counts only the time the server was producing tokens
- Requests running and waiting
- KV cache usage
- Prefix-cache hit rate
- MTP (speculative decoding) acceptance rate
- A generation tok/s sparkline covering the selected window
- The selected window, remembered across reloads in `localStorage`
- An explicit "Model server unreachable" state when the endpoint cannot be reached
- Claude plan usage for your default Claude subscription: how much of the current 5-hour session, the weekly limit and the weekly Fable limit is used, with the reset time on hover

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
| `metricsUrl` | string | `http://127.0.0.1:18081/metrics` | Prometheus metrics endpoint of the vLLM server. |
| `authToken` | string | *(none)* | Optional. Sent as `Authorization: Bearer <token>`. Prefer a secret reference over a literal value. |
| `modelName` | string | `swift-1.5` | Value of the `model_name` label to read. |
| `pollIntervalMs` | number | `5000` | Poll interval in milliseconds; minimum 1000, clamped to 60000. |

The current endpoint answers with HTTP 200 and no `Authorization` header, so the token is optional — the plugin sends one only when configured.

### The token

Resolution precedence is: **operator config → environment variable → none**. If `authToken` is unset in the company config, the worker falls back to `THROUGHPUT_METRICS_TOKEN`; if that is also unset, no `Authorization` header is sent.

For the config route, the `authToken` value may be either a literal string or a Paperclip secret reference object:

```json
{ "type": "secret_ref", "secretId": "<uuid>" }
```

The secret reference is the recommended form. The plugin resolves it at call time for each poll, keeps the resolved value in memory only, and never caches or logs it. **Never commit a token, API key, or secret value to this repository.**

### Environment variables (dev server only)

The worker reads these variables:

| Variable | Overrides |
| --- | --- |
| `THROUGHPUT_METRICS_URL` | `metricsUrl` |
| `THROUGHPUT_METRICS_TOKEN` | `authToken` |
| `THROUGHPUT_MODEL_NAME` | `modelName` |

They are **not** delivered by the Paperclip host. The host builds each plugin worker's environment from scratch (a minimal set: `PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`, and a couple of deployment-mode variables) and deliberately does not forward its own `process.env` into the worker. So for an installed plugin these variables are always empty, and they are only useful when running the worker outside the host, such as under the plugin SDK dev server.

For an installed plugin, **operator config is the only supported way** to set `metricsUrl`, `authToken`, and `modelName` — see [Configure](#configure).

## Verify

Run these on the Paperclip host. The two `/api/plugins` routes below need a **board instance-admin credential** (`<BOARD_API_KEY>`); the direct `18081/metrics` check in step 4 does not.

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

4. Check the data source directly, without the plugin at all:

   ```bash
   curl -s http://127.0.0.1:18081/metrics | grep vllm:generation_tokens_total
   ```

   If this returns lines, the endpoint is up and the panel should follow within a few seconds.

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

- **Panel shows "Model server unreachable".** The worker cannot reach the endpoint. Check the endpoint directly (`curl -s http://127.0.0.1:18081/metrics`), check the configured `metricsUrl`, and check the token (a 401/403 from the endpoint means the token is missing or wrong).
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
- **Wrong `model_name`.** The metrics are labelled `model_name="swift-1.5"`. If the configured `modelName` does not match, the worker logs a `no vllm metrics for model "..."` error and the panel stays empty. Set `modelName` to `swift-1.5` (or whatever label the server actually serves).

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

- The panel is fixed bottom-right; it is not draggable or resizable.
- The prefix-cache hit rate and MTP acceptance rate are cumulative since the model server started; the average-window selector does not affect them.
- A counter reset (a model server restart) clears the sample window, so rates read `—` for one poll afterwards until two fresh samples accumulate.
- The windowed average skips intervals with no tokens, so it is an average of active throughput, not of wall-clock time; a window in which nothing ran at all reads `0`. The instantaneous readout and the sparkline are not filtered this way.
- Claude plan usage is shown only in the expanded card, not in the collapsed pill.
- The Fable row comes only from Anthropic's usage check: it shows `—` until a check succeeds, or when the account has no Fable window. The 5h and weekly rows are as fresh as the newer of the last Claude call an agent made through Paperclip and the last successful usage check. A bar whose window has reset since its reading shows `—`.
- With several Claude subscriptions connected, the section shows your default one, as set in Paperclip's AI connections.
