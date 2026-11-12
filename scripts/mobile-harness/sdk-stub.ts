/**
 * Stand-in for `@paperclipai/plugin-sdk/ui` used only by the screenshot
 * harness (RUK-1412). `usePluginData` needs Paperclip's plugin bridge, so the
 * harness bundles this file in its place (esbuild `alias`) and the real panel
 * renders from the fixtures below at phone size.
 */
import type {
  ServersSnapshot,
  SparklinePoint,
  ThroughputSnapshot,
} from "../../src/types.ts";
import { ServerKind, ServerStatus } from "../../src/types.ts";
import type { PlanProbeSnapshot } from "../../src/usage/probe-types.ts";
import type { PlanUsageRow, PlanUsageSource } from "../../src/usage/types.ts";

/** Return shape of the SDK hook this stub replaces. */
export interface StubPluginData<T> {
  data: T | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  refresh: () => void;
}

/** Created once: the panel keeps `refresh` in `useEffect` dependencies. */
function refresh(): void {
  // The fixtures never change, so there is nothing to re-read.
}

/** 30 points, one every 10 s ending at `now`, waving between `base ∓ amplitude`. */
function makeSparkline(now: number, base: number, amplitude: number, phase: number): SparklinePoint[] {
  const points: SparklinePoint[] = [];
  for (let i = 0; i < 30; i += 1) {
    const raw = base + amplitude * Math.sin((i + phase) * 0.7);
    points.push({ at: now - (29 - i) * 10_000, tokensPerSec: Math.round(raw * 10) / 10 });
  }
  return points;
}

const NOW = Date.now();
const ISO_NOW = new Date(NOW).toISOString();

function hpcserverModel(): ThroughputSnapshot {
  return {
    status: ServerStatus.Ok,
    lastSampleAt: ISO_NOW,
    error: null,
    instant: { generation: 141.8, prompt: 1986.4 },
    averages: {
      "1m": { generation: 128.4, prompt: 1802.9 },
      "5m": { generation: 104.7, prompt: 1512.3 },
      "15m": { generation: 96.2, prompt: 1440.8 },
    },
    perRequestTokensPerSec: { "1m": 108.6, "5m": 96.1, "15m": 93.4 },
    timeToFirstTokenMs: { "1m": 386, "5m": 421, "15m": 448 },
    historySpanMs: 290_000,
    numRequestsRunning: 2,
    numRequestsWaiting: 0,
    kvCacheUsagePct: 43.7,
    prefixCacheHitRatePct: 87.3,
    mtpAcceptanceRatePct: 71.5,
    // 40..160 tok/s, the range the panel's sparkline is meant to wave across.
    sparkline: makeSparkline(NOW, 100, 60, 0),
    modelName: "swift-1.5",
  };
}

function a9Model(): ThroughputSnapshot {
  return {
    status: ServerStatus.Ok,
    lastSampleAt: ISO_NOW,
    error: null,
    instant: { generation: 47.3, prompt: 611.2 },
    averages: {
      "1m": { generation: 45.1, prompt: 588.7 },
      "5m": { generation: 41.6, prompt: 540.4 },
      "15m": { generation: 39.8, prompt: 512.9 },
    },
    perRequestTokensPerSec: { "1m": 46.9, "5m": 44.2, "15m": 43.1 },
    timeToFirstTokenMs: { "1m": 921, "5m": 1004, "15m": 1102 },
    historySpanMs: 290_000,
    numRequestsRunning: 1,
    numRequestsWaiting: 1,
    kvCacheUsagePct: 12.4,
    prefixCacheHitRatePct: 61.8,
    // llama.cpp has no speculative decode: the panel shows "—" for null.
    mtpAcceptanceRatePct: null,
    sparkline: makeSparkline(NOW, 44, 12, 2),
    // llama.cpp publishes no model label.
    modelName: null,
  };
}

const serversSnapshot: ServersSnapshot = {
  servers: [
    {
      slot: 1,
      label: "hpcserver",
      kind: ServerKind.Vllm,
      status: ServerStatus.Ok,
      error: null,
      lastSampleAt: ISO_NOW,
      models: [hpcserverModel()],
    },
    {
      slot: 2,
      label: "A9 Mega",
      kind: ServerKind.LlamaCpp,
      status: ServerStatus.Ok,
      error: null,
      lastSampleAt: ISO_NOW,
      models: [a9Model()],
    },
    {
      slot: 3,
      label: "M5U",
      kind: ServerKind.Omlx,
      status: ServerStatus.Unreachable,
      error: "connect ECONNREFUSED 127.0.0.1:18083",
      lastSampleAt: new Date(NOW - 42 * 60_000).toISOString(),
      models: [],
    },
  ],
};

const PROBE_SOURCE: PlanUsageSource = "probe";

function meter(usedPercent: number, resetsInMs: number): PlanUsageRow {
  return { usedPercent, resetsAt: new Date(NOW + resetsInMs).toISOString() };
}

const planProbeSnapshot: PlanProbeSnapshot = {
  intervalMinutes: 15,
  accounts: [
    {
      label: "Main",
      last: {
        reading: {
          source: PROBE_SOURCE,
          at: new Date(NOW - 4 * 60_000).toISOString(),
          usage: {
            session: meter(37, 3 * 3_600_000),
            weekly: meter(64, 2 * 86_400_000),
            fable: meter(12, 5 * 86_400_000),
          },
        },
        status: "allowed",
        rateLimitType: "seven_day",
        overageStatus: null,
        overageDisabledReason: null,
      },
      lastAttemptAt: new Date(NOW - 4 * 60_000).toISOString(),
      error: null,
      probing: false,
    },
  ],
};

/**
 * Same signature as the SDK hook; `params` is accepted and ignored (the panel
 * passes `{ active }` for `"plan-probe"`). Unknown keys report no data.
 */
export function usePluginData<T>(key: string, params?: Record<string, unknown>): StubPluginData<T> {
  void params;
  const data: unknown = key === "servers" ? serversSnapshot : key === "plan-probe" ? planProbeSnapshot : null;
  return { data: data as T | null, loading: false, error: null, refresh };
}
