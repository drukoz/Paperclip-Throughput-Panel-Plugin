import type { ProbeAccountState } from "./probe-types.ts";
import type { PlanUsageRow, PlanUsageView } from "./types.ts";

/** Note under a blocked account's meters. */
export const LIMIT_REACHED_NOTE = "Limit reached: Claude is blocked on this account until the reset";
/** Note when Anthropic reported the weekly window but not the 5-hour one. */
export const WEEKLY_ONLY_NOTE = "Anthropic reports only the weekly limit right now";

/** The one-line note under an account's meters, or null when none is needed. */
export function probeNote(state: ProbeAccountState): string | null {
  if (state.error !== null) return `Last check failed: ${state.error}`;
  const last = state.last;
  if (last === null) return null;
  if (last.status === "rejected") return LIMIT_REACHED_NOTE;
  if (last.reading.usage.session === null && last.reading.usage.weekly !== null) return WEEKLY_ONLY_NOTE;
  return null;
}

/** The "Claude plan" section view for one checked account. */
export function probeAccountView(state: ProbeAccountState): PlanUsageView {
  const last = state.last;
  if (last === null) {
    return state.error !== null ? { kind: "error", message: state.error } : { kind: "loading" };
  }
  const { at, usage } = last.reading;
  const tag = (row: PlanUsageRow | null): PlanUsageRow | null =>
    row === null ? null : { usedPercent: row.usedPercent, resetsAt: row.resetsAt, source: "probe", at };
  return {
    kind: "ok",
    usage: { session: tag(usage.session), weekly: tag(usage.weekly), fable: tag(usage.fable) },
    accountLabel: state.label,
    checkedAt: at,
    refreshError: probeNote(state),
  };
}
