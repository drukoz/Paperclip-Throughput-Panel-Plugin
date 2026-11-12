import { selectPlanUsage } from "./select.ts";
import type { PlanUsageResult, StoredPlanUsage } from "./types.ts";

/** Gap between automatic usage checks. */
export const PLAN_USAGE_CHECK_MS = 900_000;
/** Gap after Anthropic rate-limited a usage check. */
export const PLAN_USAGE_RATE_LIMITED_CHECK_MS = 1_800_000;
/** The refresh button forces a usage check only when the last attempt is at least this old. */
export const PLAN_USAGE_MANUAL_CHECK_GAP_MS = 300_000;

/** The part of the browser's Storage the panel uses; tests pass a Map-backed fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageRow(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value["usedPercent"])) return false;
  return value["resetsAt"] === null || typeof value["resetsAt"] === "string";
}

function isReading(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["source"] !== "agent_run" && value["source"] !== "usage_check") return false;
  if (typeof value["at"] !== "string") return false;
  const usage = value["usage"];
  if (!isRecord(usage)) return false;
  return (
    isUsageRow(usage["session"]) && isUsageRow(usage["weekly"]) && isUsageRow(usage["fable"])
  );
}

function isResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value["kind"] === "ok" ||
    value["kind"] === "no_connection" ||
    value["kind"] === "needs_attention" ||
    value["kind"] === "error"
  );
}

/** localStorage key for one company's usage-check state. */
export function planUsageStorageKey(companyId: string): string {
  return `rukoz.throughput-panel.planUsage.v1.${companyId}`;
}

/** Reads the stored state; null when storage is null, the key is missing, or the value is unreadable or the wrong shape. Never throws. */
export function loadStoredPlanUsage(
  storage: KeyValueStorage | null,
  companyId: string,
): StoredPlanUsage | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(planUsageStorageKey(companyId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (!isFiniteNumber(parsed["lastAttemptAt"])) return null;
    if (!isFiniteNumber(parsed["nextCheckAt"])) return null;
    const accountLabel = parsed["accountLabel"];
    if (accountLabel !== null && typeof accountLabel !== "string") return null;
    const good = parsed["good"];
    if (good !== null && !isReading(good)) return null;
    const last = parsed["last"];
    if (last !== null && !isResult(last)) return null;
    return parsed as unknown as StoredPlanUsage;
  } catch {
    // getItem can throw in privacy modes; a shape we do not recognise is a miss, not an error.
    return null;
  }
}

/** Writes the state as JSON; does nothing when storage is null, and ignores storage errors. Never throws. */
export function saveStoredPlanUsage(
  storage: KeyValueStorage | null,
  companyId: string,
  value: StoredPlanUsage,
): void {
  if (storage === null) return;
  try {
    storage.setItem(planUsageStorageKey(companyId), JSON.stringify(value));
  } catch {
    // setItem throws when the quota is full; the panel just loses the shared schedule.
  }
}

/** Folds one usage-check result, received at `now` (epoch ms), into the stored state. */
export function applyCheckResult(
  previous: StoredPlanUsage | null,
  result: PlanUsageResult,
  now: number,
): StoredPlanUsage {
  const rateLimited = result.kind === "error" && result.rateLimited;
  const good =
    result.kind === "ok"
      ? { source: "usage_check" as const, at: result.checkedAt, usage: selectPlanUsage(result.limits) }
      : (previous?.good ?? null);
  const accountLabel =
    result.kind === "ok" || result.kind === "needs_attention"
      ? result.accountLabel
      : (previous?.accountLabel ?? null);
  return {
    lastAttemptAt: now,
    nextCheckAt: now + (rateLimited ? PLAN_USAGE_RATE_LIMITED_CHECK_MS : PLAN_USAGE_CHECK_MS),
    good,
    accountLabel,
    last: result,
  };
}

/** True when an automatic usage check should run at `now`: nothing stored yet, or `nextCheckAt` has passed. */
export function isCheckDue(stored: StoredPlanUsage | null, now: number): boolean {
  return stored === null || now >= stored.nextCheckAt;
}

/** True when the refresh button may force a usage check at `now`: nothing stored yet, or the last attempt is at least 5 min old. */
export function manualCheckAllowed(stored: StoredPlanUsage | null, now: number): boolean {
  return stored === null || now - stored.lastAttemptAt >= PLAN_USAGE_MANUAL_CHECK_GAP_MS;
}
