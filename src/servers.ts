import type { ServerSnapshot, SelectedSamples, ThroughputSnapshot } from "./types.ts";
import { ServerKind, ServerStatus } from "./types.ts";
import { ThroughputWindow } from "./metrics/rates.ts";
import { buildSnapshot } from "./snapshot.ts";

/** One enabled model server from the plugin settings. */
export interface ServerSetting {
  /** Settings slot, 1, 2 or 3. */
  slot: number;
  /** Display name, from the settings or the slot's default. */
  label: string;
  /** Metrics endpoint, from the settings, the environment or the slot's default. */
  metricsUrl: string;
  /** Raw config value: a non-empty trimmed string, a secret_ref object, or null. Never the resolved value. */
  token: unknown;
  /** Optional model_name filter (slot 1 only); null shows every model. */
  modelName: string | null;
}

/** A string with a non-empty `trim()`, as its trimmed value; null for anything else. */
function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A token config value as a trimmed non-blank string, a secret_ref object, or null. */
function normalizeToken(value: unknown): unknown {
  const text = nonBlankString(value);
  if (text !== null) return text;
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "secret_ref") {
    return value;
  }
  return null;
}

/** Server 2's default endpoint: the A9 Mega through the launchd forwarder `com.drukoz.llm-forward-a9`. */
const A9_METRICS_URL = "http://127.0.0.1:18082/metrics";

/**
 * The A9 Mega's read-only metrics key, hard-coded at the owner's request (RUK-869) so the A9 works with no
 * settings. Caddy on the A9 accepts it only for `/metrics` and `/v1/models`, never for inference
 * (`A9_METRICS_KEY` in `/etc/caddy/a9-llm.env`). It is sent only to the default A9 URL; a `server2Token`
 * setting overrides it. To rotate it, change it on the A9 and here together.
 */
const A9_METRICS_KEY = "96de6fb9fb1af39350a3f35979edae48a3fda452d427f17f56ae78db8c792b67";

/** The enabled servers in slot order, from the config table in the contract. */
export function resolveServers(
  config: Record<string, unknown> | null,
  env: Record<string, string | undefined> = process.env,
): ServerSetting[] {
  const cfg = config ?? {};
  const servers: ServerSetting[] = [];

  const url1 =
    nonBlankString(cfg.metricsUrl) ?? nonBlankString(env.THROUGHPUT_METRICS_URL) ?? "http://127.0.0.1:18081/metrics";
  servers.push({
    slot: 1,
    label: nonBlankString(cfg.server1Label) ?? "hpcserver",
    metricsUrl: url1,
    token: normalizeToken(cfg.authToken) ?? normalizeToken(env.THROUGHPUT_METRICS_TOKEN),
    modelName: nonBlankString(cfg.modelName) ?? nonBlankString(env.THROUGHPUT_MODEL_NAME) ?? null,
  });

  const raw2 = cfg.server2MetricsUrl;
  const url2 = typeof raw2 === "string" ? raw2.trim() : A9_METRICS_URL;
  if (url2 !== "") {
    servers.push({
      slot: 2,
      label: nonBlankString(cfg.server2Label) ?? "A9 Mega",
      metricsUrl: url2,
      token: normalizeToken(cfg.server2Token) ?? (url2 === A9_METRICS_URL ? A9_METRICS_KEY : null),
      modelName: null,
    });
  }

  const url3 = nonBlankString(cfg.server3MetricsUrl);
  if (url3 !== null) {
    servers.push({
      slot: 3,
      label: nonBlankString(cfg.server3Label) ?? "Server 3",
      metricsUrl: url3,
      token: normalizeToken(cfg.server3Token),
      modelName: null,
    });
  }

  return servers;
}

/** Everything `createServerPoller` needs from the outside, injected for tests. */
export interface ServerPollerDeps {
  /** Fetch a URL with the given headers and a per-request abort signal. */
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  /** Turn a raw token config value into a bearer token, or null. */
  resolveToken: (raw: unknown) => Promise<string | null>;
  /** Split a scrape body into per-model samples, or null when it is neither format. */
  select: (text: string, options: { at: number; modelName?: string }) => SelectedSamples | null;
  /** Current time in ms. */
  now: () => number;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

/** Polls one configured model server and builds its `ServerSnapshot`. */
export interface ServerPoller {
  /** The server settings this poller reads. */
  readonly setting: ServerSetting;
  /** One scrape. Never throws. */
  poll(): Promise<void>;
  /** The server's current state, for the panel. */
  snapshot(): ServerSnapshot;
  /** After this, a poll still in flight changes nothing. */
  dispose(): void;
}

/** Scrape interval for llama.cpp's `/v1/models` model name, in ms. */
const NAME_FETCH_INTERVAL_MS = 60_000;

/** Create a poller for one server setting, with all outside world injected through `deps`. */
export function createServerPoller(setting: ServerSetting, deps: ServerPollerDeps): ServerPoller {
  const windows = new Map<string, ThroughputWindow>();
  let lastError: string | null = null;
  let started = false;
  let kind: ServerKind = ServerKind.Unknown;
  let lastSampleAt: number | null = null;
  let llamaName: string | null = null;
  let lastNameFetchAt: number | null = null;
  let disposed = false;

  async function poll(): Promise<void> {
    try {
      const token = await deps.resolveToken(setting.token);
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await deps.fetch(setting.metricsUrl, { headers, signal: AbortSignal.timeout(deps.timeoutMs) });
      if (disposed) return;
      if (!res.ok) {
        lastError = `HTTP ${res.status} ${res.statusText}`.trim();
        if ((res.status === 401 || res.status === 403) && token === null) {
          lastError += " — set this server's token in the plugin settings";
        }
        return;
      }
      const at = deps.now();
      const selected = deps.select(
        await res.text(),
        setting.modelName === null ? { at } : { at, modelName: setting.modelName },
      );
      if (disposed) return;
      if (selected === null) {
        lastError = `no vLLM or llama.cpp metrics at ${setting.metricsUrl}`;
        return;
      }
      kind = selected.kind;
      const seen = new Set<string>();
      for (const model of selected.models) {
        const key = model.modelName ?? "";
        seen.add(key);
        let window = windows.get(key);
        if (window === undefined) {
          window = new ThroughputWindow();
          windows.set(key, window);
        }
        window.push(model.sample);
      }
      for (const key of [...windows.keys()]) {
        if (!seen.has(key)) windows.delete(key);
      }
      lastError = null;
      lastSampleAt = at;

      if (kind === ServerKind.LlamaCpp && (lastNameFetchAt === null || at - lastNameFetchAt >= NAME_FETCH_INTERVAL_MS)) {
        lastNameFetchAt = at;
        try {
          const nameUrl = new URL("/v1/models", setting.metricsUrl).toString();
          const nameRes = await deps.fetch(nameUrl, { headers, signal: AbortSignal.timeout(deps.timeoutMs) });
          if (nameRes.ok) {
            const body: unknown = await nameRes.json();
            const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
            const first = Array.isArray(data) && data.length > 0 ? data[0] : undefined;
            const id = typeof first === "object" && first !== null ? (first as { id?: unknown }).id : undefined;
            if (!disposed && typeof id === "string" && id !== "") llamaName = id;
          }
        } catch {
          /* the name is optional */
        }
      }
    } catch (err) {
      if (!disposed) lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposed) started = true;
    }
  }

  function snapshot(): ServerSnapshot {
    const status: ServerStatus = !started
      ? ServerStatus.Starting
      : lastError !== null
        ? ServerStatus.Unreachable
        : ServerStatus.Ok;
    const models: ThroughputSnapshot[] = [...windows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, window]) =>
        buildSnapshot({
          window,
          lastError,
          started,
          modelName: key === "" ? (kind === ServerKind.LlamaCpp ? llamaName : null) : key,
        }),
      );
    return {
      slot: setting.slot,
      label: setting.label,
      kind,
      status,
      error: lastError,
      lastSampleAt: lastSampleAt === null ? null : new Date(lastSampleAt).toISOString(),
      models,
    };
  }

  function dispose(): void {
    disposed = true;
  }

  return { setting, poll, snapshot, dispose };
}
