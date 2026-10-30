import { selectPlanUsage } from "./select.ts";
import type {
  PlanUsage,
  PlanUsageReading,
  PlanUsageResult,
  PlanUsageRow,
  PlanUsageView,
  StoredPlanUsage,
} from "./types.ts";

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

/** Note under the meters while Anthropic rate-limits usage checks. */
export const RATE_LIMITED_NOTE = "Anthropic is rate-limiting usage checks; Fable may be out of date";

/** The newer of two readings by `at`; `next` wins ties and unparseable times. */
export function newerReading(previous: PlanUsageReading | null, next: PlanUsageReading): PlanUsageReading {
  if (previous !== null) {
    const previousAt = Date.parse(previous.at);
    const nextAt = Date.parse(next.at);
    if (Number.isFinite(previousAt) && Number.isFinite(nextAt) && previousAt > nextAt) {
      return previous;
    }
  }
  return next;
}

/** Per meter, the row from the reading with the latest `at` (the earlier one in the array wins a tie), tagged with that reading's source and at. */
export function mergeReadings(readings: readonly (PlanUsageReading | null)[]): PlanUsage {
  const merged: PlanUsage = { session: null, weekly: null, fable: null };
  for (const key of ["session", "weekly", "fable"] as const) {
    let winner: PlanUsageReading | null = null;
    let winnerAt = -Infinity;
    for (const reading of readings) {
      if (reading === null || reading.usage[key] === null) continue;
      const parsed = Date.parse(reading.at);
      const at = Number.isFinite(parsed) ? parsed : -Infinity;
      if (winner === null || at > winnerAt) {
        winner = reading;
        winnerAt = at;
      }
    }
    const row = winner === null ? null : winner.usage[key];
    if (winner !== null && row !== null) {
      merged[key] = { usedPercent: row.usedPercent, resetsAt: row.resetsAt, source: winner.source, at: winner.at };
    }
  }
  return merged;
}

/** The one-line note about the last usage check, or null when it needs none. */
export function checkNote(last: PlanUsageResult | null): string | null {
  if (last === null) return null;
  switch (last.kind) {
    case "ok":
      return null;
    case "no_connection":
      return "No Claude subscription connected";
    case "needs_attention":
      return last.message;
    case "error":
      return last.rateLimited ? RATE_LIMITED_NOTE : `Usage check failed: ${last.message}`;
  }
}

/** What the "Claude plan" section shows, from the newest agent-run reading and the stored usage check. */
export function buildPlanUsageView(
  runs: PlanUsageReading | null,
  stored: StoredPlanUsage | null,
): PlanUsageView {
  const last = stored?.last ?? null;
  const usage = mergeReadings([runs, stored?.good ?? null]);
  const rows = [usage.session, usage.weekly, usage.fable].filter(
    (row): row is PlanUsageRow => row !== null,
  );
  if (rows.length > 0) {
    let checkedAt = "";
    let newestAt = -Infinity;
    for (const row of rows) {
      const parsed = row.at === undefined ? Number.NaN : Date.parse(row.at);
      const at = Number.isFinite(parsed) ? parsed : -Infinity;
      if (at > newestAt) {
        newestAt = at;
        checkedAt = row.at ?? "";
      }
    }
    return {
      kind: "ok",
      usage,
      accountLabel: stored?.accountLabel ?? "Claude",
      checkedAt,
      refreshError: checkNote(last),
    };
  }
  if (last === null) return { kind: "loading" };
  switch (last.kind) {
    case "ok":
      return {
        kind: "ok",
        usage,
        accountLabel: last.accountLabel,
        checkedAt: last.checkedAt,
        refreshError: null,
      };
    case "no_connection":
      return { kind: "no_connection" };
    case "needs_attention":
      return { kind: "needs_attention", accountLabel: last.accountLabel, message: last.message };
    case "error":
      return { kind: "error", message: last.message };
  }
}
