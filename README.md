# Model Throughput Panel

## What it is

A Paperclip plugin that shows a live tokens/sec readout for the local vLLM model server, as a small floating panel in the Paperclip UI. It polls the server's Prometheus metrics endpoint from a worker on the Paperclip host and renders generation and prompt throughput, request counts, cache stats, and a short sparkline. The plugin id is `rukoz.throughput-panel`.

The panel shows:

- Generation and prompt tok/s, with a 1-minute average
- Requests running and waiting
- KV cache usage
- Prefix-cache hit rate
- MTP (speculative decoding) acceptance rate
- A 5-minute generation tok/s sparkline
- An explicit "Model server unreachable" state when the endpoint cannot be reached

## How it works

The worker polls the metrics endpoint every 5 s by default (configurable via `pollIntervalMs`, clamped to 1–60 s), keeps a 5-minute window of samples, and computes rates from counter deltas between samples. The UI is an `appShellOverlay` slot that reads a snapshot from the worker over the plugin bridge every 5 s.

Polling happens worker-side because the browser cannot reach `127.0.0.1:18081` on the Paperclip host — the endpoint is bound to the host's loopback, so only a process running on that host can scrape it.

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

- **Panel shows "Model server unreachable".** The worker cannot reach the endpoint. Check the endpoint directly (`curl -s http://127.0.0.1:18081/metrics`), check the configured `metricsUrl`, and check the token (a 401/403 from the endpoint means the token is missing or wrong).
- **Panel shows "Model server unreachable" with an error mentioning "private/reserved ranges".** The worker is routing through the host's guarded HTTP client instead of scraping directly; that is the bug fixed in RUK-52, so make sure the installed build includes it.
- **Panel shows "Panel unavailable".** The worker itself is not responding. Check the logs for worker errors with `paperclipai plugin logs rukoz.throughput-panel`, then restart it with a disable/enable cycle:

  ```bash
  paperclipai plugin disable rukoz.throughput-panel
  paperclipai plugin enable rukoz.throughput-panel
  ```
- **The model server restarted and the panel stopped updating.** The worker recovers on its own: a failed poll is caught, `lastError` is set, and the next interval retries — the poll loop is never torn down by a failed scrape. A counter reset (which is what a vLLM restart looks like, because the cumulative counters drop) clears the sample window, so rates read `—` for one poll and refill within about 10 s (two poll cycles); this is the same behaviour noted in [Scope and limits](#scope-and-limits) below. If the plugin **worker process** was replaced (a host restart, or the worker being respawned), an already-open browser tab can keep showing the snapshot it last received — **reload the browser page** to re-establish the UI data bridge. Reloading the page is the first thing to try, and it is cheaper than a disable/enable cycle. Only if a page reload does not help is a disable/enable cycle warranted, and the logs (`paperclipai plugin logs rukoz.throughput-panel`) are the place to look.
- **Panel shows `—` for everything.** Fewer than two samples are in the window yet, so no rate can be computed. Wait about 10 s (two poll cycles) and it should fill in.
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
  metrics/
    parse.ts           Prometheus text-format parser and vLLM sample selector
    parse.test.ts      Tests for the parser and selector
    rates.ts           5-minute ThroughputWindow; rates computed from counter deltas
    rates.test.ts      Tests for the window and rate math
  ui/
    index.tsx          ThroughputPanel widget rendered in the appShellOverlay slot
    format.ts          Display formatters for rates, percentages, counts, and ages
    format.test.ts     Tests for the formatters
    Sparkline.tsx      SVG sparkline for the 5-minute generation rate
```

## Scope and limits

- The panel is fixed bottom-right; it is not draggable or resizable.
- The prefix-cache hit rate and MTP acceptance rate are cumulative since the model server started, not windowed to the last 5 minutes.
- A counter reset (a model server restart) clears the sample window, so rates read `—` for one poll afterwards until two fresh samples accumulate.
