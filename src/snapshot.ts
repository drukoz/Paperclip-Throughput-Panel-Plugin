import type { RatePair, ThroughputSnapshot } from "./types.ts";
import { ServerStatus } from "./types.ts";
import type { AverageWindowKey } from "./windows.ts";
import { AVERAGE_WINDOW_KEYS, AVERAGE_WINDOW_MS } from "./windows.ts";
import { ThroughputWindow } from "./metrics/rates.ts";

export interface SnapshotInput {
  window: ThroughputWindow;
  /** null while no scrape has failed. */
  lastError: string | null;
  /** true once at least one scrape attempt has completed, successfully or not. */
  started: boolean;
  /** `model_name` label from the last successful scrape. */
  modelName: string | null;
}

function emptyAverages(): Record<AverageWindowKey, RatePair | null> {
  return { "1m": null, "5m": null, "15m": null };
}

function emptyNumbers(): Record<AverageWindowKey, number | null> {
  return { "1m": null, "5m": null, "15m": null };
}

export function buildSnapshot(input: SnapshotInput): ThroughputSnapshot {
  const { window, lastError, started, modelName } = input;

  let status: ServerStatus;
  if (!started) {
    status = ServerStatus.Starting;
  } else if (lastError !== null && lastError.length > 0) {
    status = ServerStatus.Unreachable;
  } else {
    status = ServerStatus.Ok;
  }

  const latest = window.latest();
  const cumulative = window.cumulativeRates();

  const snapshot: ThroughputSnapshot = {
    status,
    lastSampleAt: latest === null ? null : new Date(latest.at).toISOString(),
    error: lastError,
    instant: null,
    averages: emptyAverages(),
    perRequestTokensPerSec: emptyNumbers(),
    timeToFirstTokenMs: emptyNumbers(),
    numRequestsRunning: null,
    numRequestsWaiting: null,
    kvCacheUsagePct: null,
    prefixCacheHitRatePct: cumulative.prefixCacheHitRatePct,
    mtpAcceptanceRatePct: cumulative.mtpAcceptanceRatePct,
    sparkline: window.sparkline(),
    historySpanMs: window.spanMs(),
    modelName,
  };

  if (status === ServerStatus.Ok && latest !== null) {
    snapshot.instant = window.instantRates();
    for (const key of AVERAGE_WINDOW_KEYS) {
      snapshot.averages[key] = window.averageRates(AVERAGE_WINDOW_MS[key]);
    }
    snapshot.numRequestsRunning = latest.numRequestsRunning;
    snapshot.numRequestsWaiting = latest.numRequestsWaiting;
    snapshot.kvCacheUsagePct = latest.kvCacheUsage === null ? null : latest.kvCacheUsage * 100;
  }

  return snapshot;
}
