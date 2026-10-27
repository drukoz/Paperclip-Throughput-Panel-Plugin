import type { SparklinePoint } from "../types.ts";
import type { AverageWindowKey } from "../windows.ts";
import { AVERAGE_WINDOW_MS } from "../windows.ts";

const CAPTIONS: Record<AverageWindowKey, string> = {
  "1m": "last 1 min",
  "5m": "last 5 min",
  "15m": "last 15 min",
};

/** Points within `windowMs` of the newest point, oldest first. */
export function pointsInWindow(
  points: readonly SparklinePoint[],
  windowMs: number,
): SparklinePoint[] {
  const newest = points[points.length - 1];
  if (newest === undefined) return [];
  const cutoff = newest.at - windowMs;
  return points.filter((point) => point.at >= cutoff);
}

/** Sparkline caption for a window: "last 1 min", "last 5 min", "last 15 min". */
export function windowCaption(key: AverageWindowKey): string {
  return CAPTIONS[key];
}

/**
 * Tooltip for the average readout. The worker averages over whatever history
 * it has, so say so when that is shorter than the selected window.
 */
export function averageTitle(
  key: AverageWindowKey,
  historySpanMs: number | null,
): string {
  if (historySpanMs !== null && historySpanMs < AVERAGE_WINDOW_MS[key]) {
    return `only ${Math.round(historySpanMs / 1000)}s of history so far`;
  }
  return `trailing ${key} average`;
}
