import type { PlanUsage, PlanUsageRow, UsageLimit } from "./types.ts";

/** windowDurationSeconds of the rolling 5-hour session window. */
export const SESSION_WINDOW_SECONDS = 18_000;
/** windowDurationSeconds of every weekly window. */
export const WEEK_WINDOW_SECONDS = 604_800;

/** Substring match on "fable"; no word boundaries, so seven_day_fable matches too. */
const FABLE_PATTERN = /fable/i;

/** True when the limit covers the whole account: no scope, or only `group:` parts. */
export function isAccountWide(limit: UsageLimit): boolean {
  return limit.scope === null || limit.scope.split(" · ").every((part) => part.startsWith("group:"));
}

/** True when the limit is a Fable limit: "fable" appears in its label or its scope. */
export function isFableLimit(limit: UsageLimit): boolean {
  return FABLE_PATTERN.test(limit.label) || (limit.scope !== null && FABLE_PATTERN.test(limit.scope));
}

/** The candidate with the highest finite usedPercent, first in array order on a tie. */
export function pickRow(candidates: readonly UsageLimit[]): PlanUsageRow | null {
  let best: PlanUsageRow | null = null;
  for (const candidate of candidates) {
    const usedPercent = candidate.usedPercent;
    if (usedPercent === null || !Number.isFinite(usedPercent)) continue;
    if (best === null || usedPercent > best.usedPercent) {
      best = { usedPercent, resetsAt: candidate.resetsAt };
    }
  }
  return best;
}

/** Turns Paperclip's limits[] into the session, weekly and Fable meters the panel shows. */
export function selectPlanUsage(limits: readonly UsageLimit[]): PlanUsage {
  const accountWide = limits.filter(isAccountWide);
  return {
    session: pickRow(
      accountWide.filter((limit) => limit.windowDurationSeconds === SESSION_WINDOW_SECONDS),
    ),
    weekly: pickRow(
      accountWide.filter((limit) => limit.windowDurationSeconds === WEEK_WINDOW_SECONDS),
    ),
    fable: pickRow(
      limits.filter(
        (limit) => limit.windowDurationSeconds === WEEK_WINDOW_SECONDS && isFableLimit(limit),
      ),
    ),
  };
}
