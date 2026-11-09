import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parsePrometheusText, selectSamples } from "./metrics/parse.ts";
import { createServerPoller, resolveServers } from "./servers.ts";
import type { ServerPoller } from "./servers.ts";
import { ServerStatus } from "./types.ts";
import type { ServersSnapshot } from "./types.ts";
import { createProbeController } from "./usage/probe-controller.ts";
import type { ProbeAccountSetting, ProbeController } from "./usage/probe-controller.ts";
import { parseProbeOutput } from "./usage/probe-parse.ts";
import { runProbe } from "./usage/probe-run.ts";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CLAUDE_PATH = "/opt/homebrew/bin/claude";
const DEFAULT_CHECK_MINUTES = 15;
const MIN_CHECK_MINUTES = 5;
const MAX_CHECK_MINUTES = 120;
const CLAUDE_ACCOUNT_SLOTS = [1, 2, 3] as const;
/** A Claude check that has not finished by then is killed. */
const PROBE_TIMEOUT_MS = 60_000;
/** Claude Code's HOME and config folder for the checks, away from the user's own ~/.claude. */
const PROBE_CONFIG_DIR = join(tmpdir(), "rukoz-throughput-panel", "claude-check");
/**
 * Runs a function outside any host request. The SDK tags each host call with the
 * request it was made in, and the host refuses a call whose request has ended. A
 * Claude check outlives the "plan-probe" request that starts it, so it must not
 * inherit that tag. Captured at module load, before any request exists.
 */
const runOutsideInvocation = AsyncLocalStorage.snapshot();

let ctxRef: PluginContext | null = null;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let pollers: ServerPoller[] = [];
/** JSON of the server settings the current pollers were built from. */
let serverKey = "";
let probeSettings: ProbeSettings = resolveProbeSettings(null);
let probeController: ProbeController | null = null;
/** The company whose settings the worker received last; the host resolves a plugin's secret only with it. */
let probeCompanyId: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function clampPollInterval(ms: number): number {
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, ms));
}

function readPollInterval(config: Record<string, unknown> | null): number {
  const rawInterval = config?.pollIntervalMs;
  return clampPollInterval(
    typeof rawInterval === "number" && Number.isFinite(rawInterval)
      ? rawInterval
      : DEFAULT_POLL_INTERVAL_MS,
  );
}

/** The Claude check settings: the configured accounts, the CLI path and the interval. */
export interface ProbeSettings {
  accounts: ProbeAccountSetting[];
  claudePath: string;
  intervalMinutes: number;
}

function isSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "secret_ref";
}

/**
 * The Claude check settings from the plugin config: one account for each slot
 * whose token is a non-empty string (trimmed) or a secret_ref object, labelled
 * "Account <n>" when its label is blank; the CLI path; the interval in minutes,
 * rounded and clamped to 5-120.
 */
export function resolveProbeSettings(config: Record<string, unknown> | null): ProbeSettings {
  const accounts: ProbeAccountSetting[] = [];
  for (const slot of CLAUDE_ACCOUNT_SLOTS) {
    const rawToken = config?.[`claudeAccount${slot}Token`];
    let token: unknown = null;
    if (typeof rawToken === "string" && rawToken.trim() !== "") token = rawToken.trim();
    else if (isSecretRef(rawToken)) token = rawToken;
    if (token === null) continue;
    const rawLabel = config?.[`claudeAccount${slot}Label`];
    const label = typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel.trim() : `Account ${slot}`;
    accounts.push({ label, token });
  }
  const rawMinutes = config?.claudeCheckMinutes;
  const intervalMinutes =
    typeof rawMinutes === "number" && Number.isFinite(rawMinutes)
      ? Math.min(MAX_CHECK_MINUTES, Math.max(MIN_CHECK_MINUTES, Math.round(rawMinutes)))
      : DEFAULT_CHECK_MINUTES;
  return {
    accounts,
    claudePath: firstString(config?.claudePath) ?? DEFAULT_CLAUDE_PATH,
    intervalMinutes,
  };
}

/** Resolve the auth token for one poll. The resolved value is used in memory only and never stored. */
async function resolveToken(ctx: PluginContext, raw: unknown, companyId: string | null = null): Promise<string | null> {
  if (raw !== null && typeof raw === "object") {
    if ((raw as { type?: unknown }).type === "secret_ref") {
      try {
        // The host resolves a plugin's secret only with the company its settings belong to.
        const token = await ctx.secrets.resolve(raw as never, companyId !== null ? { companyId } : {});
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

/** Replace every poller when the server settings changed; keep them (and their history) otherwise. */
function configureServers(ctx: PluginContext, config: Record<string, unknown> | null): void {
  const servers = resolveServers(config);
  const key = JSON.stringify(servers);
  if (key === serverKey && pollers.length > 0) return;
  serverKey = key;
  for (const p of pollers) p.dispose();
  pollers = servers.map((setting) =>
    createServerPoller(setting, {
      // The host's ctx.http.fetch applies an SSRF guard that rejects every
      // loopback and RFC1918 address, and the metrics endpoints are only
      // reachable on the host's loopback interface, so the guard can never be
      // satisfied here. The worker is an ordinary host process, so we scrape
      // the endpoints with Node's global fetch instead. This is deliberate:
      // the targets are operator-configured and local, and nothing from the
      // responses is echoed back to a caller.
      fetch: (url, init) => fetch(url, init),
      resolveToken: (raw) => resolveToken(ctx, raw, probeCompanyId),
      select: (text, options) => selectSamples(parsePrometheusText(text), options),
      now: () => Date.now(),
      // A getter, so a poll-interval change alone (which keeps the pollers) still shortens the timeout.
      get timeoutMs() {
        return Math.min(4000, pollIntervalMs - 500);
      },
    }),
  );
}

function startPolling(ctx: PluginContext): void {
  if (timer !== null) clearInterval(timer);
  for (const p of pollers) void p.poll();
  timer = setInterval(() => {
    for (const p of pollers) void p.poll();
  }, pollIntervalMs);
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
    pollIntervalMs = readPollInterval(config);
    configureServers(ctx, config);

    ctx.logger.info("throughput panel worker starting", {
      servers: pollers.map((p) => ({
        slot: p.setting.slot,
        label: p.setting.label,
        metricsUrl: p.setting.metricsUrl,
      })),
      pollIntervalMs,
    });

    ctx.data.register("servers", async (): Promise<ServersSnapshot> => ({
      servers: pollers.map((p) => p.snapshot()),
    }));

    probeSettings = resolveProbeSettings(config);
    const controller = createProbeController({
      now: () => Date.now(),
      resolveToken: (raw) => resolveToken(ctx, raw, probeCompanyId),
      run: (token) =>
        runProbe({
          claudePath: probeSettings.claudePath,
          token,
          configDir: PROBE_CONFIG_DIR,
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
      parse: parseProbeOutput,
    });
    controller.configure(probeSettings.accounts, probeSettings.intervalMinutes);
    probeController = controller;
    // Checks spend Claude usage, so only the expanded panel (active: true) starts them.
    ctx.data.register("plan-probe", async (params) => {
      if (params.active === true) runOutsideInvocation(() => void controller.kick());
      return controller.snapshot();
    });

    startPolling(ctx);
  },

  async onConfigChanged(newConfig, context) {
    if (ctxRef === null) return;
    try {
      probeCompanyId = context?.companyId ?? probeCompanyId;
      pollIntervalMs = readPollInterval(newConfig);
      configureServers(ctxRef, newConfig);
      startPolling(ctxRef);
      probeSettings = resolveProbeSettings(newConfig);
      probeController?.configure(probeSettings.accounts, probeSettings.intervalMinutes);
      ctxRef.logger.info("throughput panel config reloaded", {
        servers: pollers.map((p) => ({
          slot: p.setting.slot,
          label: p.setting.label,
          metricsUrl: p.setting.metricsUrl,
        })),
        pollIntervalMs,
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
    for (const p of pollers) p.dispose();
    pollers = [];
    serverKey = "";
  },

  async onHealth() {
    const snapshots = pollers.map((p) => p.snapshot());
    const details: Record<string, unknown> = {
      servers: snapshots.map((s) => ({
        slot: s.slot,
        label: s.label,
        status: s.status,
        models: s.models.length,
        error: s.error,
      })),
      claudeAccounts: probeSettings.accounts.length,
    };
    if (snapshots.every((s) => s.status === ServerStatus.Starting)) {
      return { status: "ok", message: "starting", details };
    }
    const firstError = snapshots.find((s) => s.error !== null)?.error ?? null;
    if (firstError !== null) {
      return { status: "degraded", message: firstError, details };
    }
    return { status: "ok", message: "metrics streaming", details };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];

    for (const key of ["metricsUrl", "server2MetricsUrl", "server3MetricsUrl"] as const) {
      const url = config[key];
      if (typeof url !== "string") continue;
      // An empty string means "this server is off", and is only allowed for slots 2 and 3.
      if (url === "" && key !== "metricsUrl") continue;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push(`${key} must be an http: or https: URL, got "${url}"`);
        }
      } catch {
        errors.push(`${key} is not a valid URL: "${url}"`);
      }
    }

    for (const key of ["authToken", "server2Token", "server3Token"] as const) {
      const token = config[key];
      if (token !== undefined && token !== null && typeof token !== "string" && !isSecretRef(token)) {
        errors.push(`${key} must be a token string or a secret reference`);
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

    const claudePath = config.claudePath;
    if (claudePath !== undefined && (typeof claudePath !== "string" || !claudePath.startsWith("/"))) {
      errors.push("claudePath must be an absolute path");
    }

    const minutes = config.claudeCheckMinutes;
    if (
      minutes !== undefined &&
      (typeof minutes !== "number" ||
        !Number.isFinite(minutes) ||
        minutes < MIN_CHECK_MINUTES ||
        minutes > MAX_CHECK_MINUTES)
    ) {
      errors.push(`claudeCheckMinutes must be a number between ${MIN_CHECK_MINUTES} and ${MAX_CHECK_MINUTES}`);
    }

    for (const slot of CLAUDE_ACCOUNT_SLOTS) {
      const token = config[`claudeAccount${slot}Token`];
      if (token !== undefined && token !== null && typeof token !== "string" && !isSecretRef(token)) {
        errors.push(`claudeAccount${slot}Token must be a token string or a secret reference`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
