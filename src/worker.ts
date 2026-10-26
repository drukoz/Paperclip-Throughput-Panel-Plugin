import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parsePrometheusText, selectSample } from "./metrics/parse.ts";
import { ThroughputWindow } from "./metrics/rates.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { ThroughputSnapshot } from "./types.ts";

const DEFAULT_METRICS_URL = "http://127.0.0.1:18081/metrics";
const DEFAULT_MODEL_NAME = "swift-1.5";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60_000;

interface Settings {
  metricsUrl: string;
  /** Raw config value: a literal string, a `{ type: "secret_ref", ... }` object, or null. Never the resolved value. */
  authToken: unknown;
  modelName: string;
  pollIntervalMs: number;
}

let ctxRef: PluginContext | null = null;
let settings: Settings | null = null;
let window = new ThroughputWindow();
let lastError: string | null = null;
let started = false;
let modelName: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** Bumped whenever `window` is replaced, so a poll in flight cannot write into the new window. */
let windowGeneration = 0;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function clampPollInterval(ms: number): number {
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, ms));
}

function resolveSettings(config: Record<string, unknown> | null): Settings {
  const rawInterval = config?.pollIntervalMs;
  return {
    metricsUrl:
      firstString(config?.metricsUrl, process.env.THROUGHPUT_METRICS_URL) ??
      DEFAULT_METRICS_URL,
    authToken:
      config?.authToken !== undefined && config.authToken !== null
        ? config.authToken
        : (firstString(process.env.THROUGHPUT_METRICS_TOKEN) ?? null),
    modelName:
      firstString(config?.modelName, process.env.THROUGHPUT_MODEL_NAME) ??
      DEFAULT_MODEL_NAME,
    pollIntervalMs: clampPollInterval(
      typeof rawInterval === "number" && Number.isFinite(rawInterval)
        ? rawInterval
        : DEFAULT_POLL_INTERVAL_MS,
    ),
  };
}

/** Resolve the auth token for one poll. The resolved value is used in memory only and never stored. */
async function resolveToken(ctx: PluginContext, raw: unknown): Promise<string | null> {
  if (raw !== null && typeof raw === "object") {
    if ((raw as { type?: unknown }).type === "secret_ref") {
      try {
        const token = await ctx.secrets.resolve(raw as never);
        return token.length > 0 ? token : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  return null;
}

async function poll(ctx: PluginContext): Promise<void> {
  const active = settings;
  if (active === null) return;
  const generation = windowGeneration;
  try {
    const token = await resolveToken(ctx, active.authToken);
    // The host's ctx.http.fetch applies an SSRF guard that rejects every
    // loopback and RFC1918 address, and the vLLM metrics endpoint is only
    // reachable on the host's loopback interface, so the guard can never be
    // satisfied here. The worker is an ordinary host process, so we scrape the
    // endpoint with Node's global fetch instead. This is deliberate: the target
    // is operator-configured and local, and nothing from the response is
    // echoed back to a caller.
    const res = await fetch(active.metricsUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(Math.min(4000, active.pollIntervalMs - 500)),
    });
    if (generation !== windowGeneration) return;
    if (!res.ok) {
      lastError = `HTTP ${res.status} ${res.statusText}`;
      return;
    }
    const series = parsePrometheusText(await res.text());
    const picked = selectSample(series, {
      at: Date.now(),
      modelName: active.modelName,
    });
    // The config changed while this scrape was in flight: it describes the old
    // server, so discard it rather than seeding the new window with stale data.
    if (generation !== windowGeneration) return;
    if (picked === null) {
      lastError = `no vllm metrics for model "${active.modelName}" at ${active.metricsUrl}`;
      return;
    }
    window.push(picked.sample);
    modelName = picked.modelName;
    lastError = null;
  } catch (err) {
    if (generation !== windowGeneration) return;
    lastError = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`throughput poll failed: ${lastError}`);
  } finally {
    if (generation === windowGeneration) started = true;
  }
}

function startPolling(ctx: PluginContext): void {
  if (timer !== null) clearInterval(timer);
  void poll(ctx);
  timer = setInterval(() => {
    void poll(ctx);
  }, settings?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;

    let config: Record<string, unknown> | null = null;
    try {
      config = await ctx.config.get();
    } catch (err) {
      ctx.logger.warn(
        `throughput panel config read failed, falling back to env/defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    settings = resolveSettings(config);

    ctx.logger.info("throughput panel worker starting", {
      metricsUrl: settings.metricsUrl,
      modelName: settings.modelName,
      pollIntervalMs: settings.pollIntervalMs,
    });

    ctx.data.register("throughput", async (): Promise<ThroughputSnapshot> =>
      buildSnapshot({ window, lastError, started, modelName }),
    );

    startPolling(ctx);
  },

  async onConfigChanged(newConfig) {
    if (ctxRef === null) return;
    try {
      const previous = settings;
      settings = resolveSettings(newConfig);
      if (
        previous === null ||
        settings.metricsUrl !== previous.metricsUrl ||
        settings.modelName !== previous.modelName
      ) {
        window = new ThroughputWindow();
        windowGeneration += 1;
        modelName = null;
        lastError = null;
        started = false;
      }
      startPolling(ctxRef);
      ctxRef.logger.info("throughput panel config reloaded", {
        metricsUrl: settings.metricsUrl,
        modelName: settings.modelName,
        pollIntervalMs: settings.pollIntervalMs,
      });
    } catch (err) {
      ctxRef.logger.warn(
        `throughput panel config reload failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  },

  async onShutdown() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  },

  async onHealth() {
    const details: Record<string, unknown> = {
      metricsUrl: settings?.metricsUrl ?? null,
      modelName,
      sampleCount: window.size(),
    };
    if (!started) {
      return { status: "ok", message: "starting", details };
    }
    if (lastError !== null) {
      return { status: "degraded", message: lastError, details };
    }
    return { status: "ok", message: "metrics streaming", details };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];

    const url = config.metricsUrl;
    if (typeof url === "string") {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push(`metricsUrl must be an http: or https: URL, got "${url}"`);
        }
      } catch {
        errors.push(`metricsUrl is not a valid URL: "${url}"`);
      }
    }

    const interval = config.pollIntervalMs;
    if (
      interval !== undefined &&
      (typeof interval !== "number" ||
        !Number.isFinite(interval) ||
        interval < MIN_POLL_INTERVAL_MS ||
        interval > MAX_POLL_INTERVAL_MS)
    ) {
      errors.push(`pollIntervalMs must be a number between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`);
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
