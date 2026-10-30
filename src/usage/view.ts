import { selectPlanUsage } from "./select.ts";
import type { PlanUsageResult, PlanUsageView } from "./types.ts";

/** Normal gap between automatic checks. */
export const PLAN_USAGE_POLL_MS = 300_000;
/** Gap after Anthropic rate-limited a check. */
export const PLAN_USAGE_RATE_LIMITED_POLL_MS = 900_000;
/** Expanding the card checks again only when the last check is at least this old. */
export const PLAN_USAGE_MIN_GAP_MS = 60_000;
/** The refresh button does nothing within this long of the last check. */
export const PLAN_USAGE_MANUAL_GAP_MS = 10_000;

/** How long to wait before the next automatic check after `result`. */
export function nextPlanUsageDelayMs(result: PlanUsageResult): number {
  if (result.kind === "error" && result.rateLimited) {
    return PLAN_USAGE_RATE_LIMITED_POLL_MS;
  }
  return PLAN_USAGE_POLL_MS;
}

/** Folds one check result into the section's view; a failed check keeps the last good meters. */
export function reducePlanUsageView(
  previous: PlanUsageView,
  result: PlanUsageResult,
): PlanUsageView {
  switch (result.kind) {
    case "ok":
      return {
        kind: "ok",
        usage: selectPlanUsage(result.limits),
        accountLabel: result.accountLabel,
        checkedAt: result.checkedAt,
        refreshError: null,
      };
    case "no_connection":
      return { kind: "no_connection" };
    case "needs_attention":
      return { kind: "needs_attention", accountLabel: result.accountLabel, message: result.message };
    case "error":
      if (previous.kind === "ok") {
        return {
          ...previous,
          refreshError: result.rateLimited
            ? "Rate limited by Anthropic, retrying in 15 min"
            : `Couldn't refresh: ${result.message}`,
        };
      }
      return { kind: "error", message: result.message };
  }
}
