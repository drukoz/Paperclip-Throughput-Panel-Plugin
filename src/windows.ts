/** Trailing windows the panel can average over and graph. */
export type AverageWindowKey = "1m" | "5m" | "15m";

/** Display order of the selector buttons, shortest first. */
export const AVERAGE_WINDOW_KEYS: readonly AverageWindowKey[] = ["1m", "5m", "15m"];

/** Length of each selectable window, in ms. */
export const AVERAGE_WINDOW_MS: Record<AverageWindowKey, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
};

/** The longest selectable window: how much sample history the worker keeps. */
export const MAX_AVERAGE_WINDOW_MS = AVERAGE_WINDOW_MS["15m"];

export function isAverageWindowKey(value: unknown): value is AverageWindowKey {
  return (
    typeof value === "string" &&
    (AVERAGE_WINDOW_KEYS as readonly string[]).includes(value)
  );
}
