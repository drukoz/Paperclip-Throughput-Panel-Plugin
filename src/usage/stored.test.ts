import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanUsageResult, UsageLimit } from "./types.ts";
import {
  applyCheckResult,
  isCheckDue,
  loadStoredPlanUsage,
  manualCheckAllowed,
  planUsageStorageKey,
  saveStoredPlanUsage,
} from "./stored.ts";
import type { KeyValueStorage } from "./stored.ts";

const LIMITS: UsageLimit[] = [
  { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-30T04:20:00.000Z", usedPercent: 13 },
  { id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-05T16:00:00.000Z", usedPercent: 4 },
  { id: "seven_day.fable", label: "Fable", scope: "group:weekly · model:Fable", windowDurationSeconds: 604800, resetsAt: "2026-11-05T16:00:00.000Z", usedPercent: 20 },
];

const OK: PlanUsageResult = {
  kind: "ok",
  accountLabel: "me@example.com",
  checkedAt: "2026-10-30T02:40:00.000Z",
  limits: LIMITS,
};

// The three meters selectPlanUsage builds from LIMITS, as the Context table gives them.
const METERS = {
  session: { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z" },
  weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z" },
  fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z" },
};

function newFakeStorage(): { map: Map<string, string>; storage: KeyValueStorage } {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
  return { map, storage };
}

test("planUsageStorageKey is the v1 key for the company", () => {
  assert.equal(planUsageStorageKey("co-1"), "rukoz.throughput-panel.planUsage.v1.co-1");
});

test("loadStoredPlanUsage returns null for null storage, a missing key, and unreadable or wrongly shaped values", () => {
  assert.equal(loadStoredPlanUsage(null, "co-1"), null);
  const { map, storage } = newFakeStorage();
  const key = planUsageStorageKey("co-1");
  assert.equal(loadStoredPlanUsage(storage, "co-1"), null);
  map.set(key, "not json");
  assert.equal(loadStoredPlanUsage(storage, "co-1"), null);
  map.set(key, JSON.stringify({ lastAttemptAt: "x" }));
  assert.equal(loadStoredPlanUsage(storage, "co-1"), null);
  const s = applyCheckResult(null, OK, 1_000);
  map.set(key, JSON.stringify({ ...s, good: { ...s.good, source: "other" } }));
  assert.equal(loadStoredPlanUsage(storage, "co-1"), null);
  map.set(key, JSON.stringify({ ...s, last: { kind: "weird" } }));
  assert.equal(loadStoredPlanUsage(storage, "co-1"), null);
});

test("loadStoredPlanUsage and saveStoredPlanUsage survive a storage that throws", () => {
  const throwingGet: KeyValueStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {},
  };
  assert.equal(loadStoredPlanUsage(throwingGet, "co-1"), null);
  const throwingSet: KeyValueStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.doesNotThrow(() => saveStoredPlanUsage(throwingSet, "co-1", applyCheckResult(null, OK, 1_000)));
});

test("saveStoredPlanUsage then loadStoredPlanUsage round trips the state", () => {
  const { storage } = newFakeStorage();
  const s = applyCheckResult(null, OK, 1_000);
  saveStoredPlanUsage(storage, "co-1", s);
  assert.deepEqual(loadStoredPlanUsage(storage, "co-1"), s);
});

test("applyCheckResult folds an ok result into a fresh state", () => {
  assert.deepEqual(applyCheckResult(null, OK, 1_000), {
    lastAttemptAt: 1_000,
    nextCheckAt: 901_000,
    good: { source: "usage_check", at: "2026-10-30T02:40:00.000Z", usage: METERS },
    accountLabel: "me@example.com",
    last: OK,
  });
});

test("a rate-limited error keeps good and accountLabel and pushes nextCheckAt 30 min out", () => {
  const s = applyCheckResult(null, OK, 1_000);
  const rateLimited: PlanUsageResult = {
    kind: "error",
    message: "The provider rate limited the usage check. Try again later.",
    rateLimited: true,
  };
  const next = applyCheckResult(s, rateLimited, 2_000);
  assert.deepEqual(next.good, s.good);
  assert.equal(next.accountLabel, "me@example.com");
  assert.equal(next.lastAttemptAt, 2_000);
  assert.equal(next.nextCheckAt, 1_802_000);
  assert.equal(next.last, rateLimited);
});

test("an error that is not rate limited keeps the 15 min gap", () => {
  const s = applyCheckResult(null, OK, 1_000);
  const serverError: PlanUsageResult = { kind: "error", message: "500", rateLimited: false };
  const next = applyCheckResult(s, serverError, 5_000);
  assert.equal(next.nextCheckAt, 905_000);
});

test("needs_attention takes the new accountLabel and keeps good; no_connection keeps both", () => {
  const s = applyCheckResult(null, OK, 1_000);
  const attention = applyCheckResult(s, { kind: "needs_attention", accountLabel: "other@example.com", message: "Reconnect" }, 2_000);
  assert.equal(attention.accountLabel, "other@example.com");
  assert.deepEqual(attention.good, s.good);
  const offline = applyCheckResult(attention, { kind: "no_connection" }, 3_000);
  assert.equal(offline.accountLabel, "other@example.com");
  assert.deepEqual(offline.good, s.good);
});

test("isCheckDue is true with nothing stored and from nextCheckAt on", () => {
  assert.equal(isCheckDue(null, 0), true);
  const s = applyCheckResult(null, OK, 1_000);
  assert.equal(isCheckDue(s, s.nextCheckAt - 1), false);
  assert.equal(isCheckDue(s, s.nextCheckAt), true);
});

test("manualCheckAllowed is true with nothing stored and once the last attempt is 5 min old", () => {
  assert.equal(manualCheckAllowed(null, 0), true);
  const s = applyCheckResult(null, OK, 1_000);
  assert.equal(manualCheckAllowed(s, s.lastAttemptAt + 299_999), false);
  assert.equal(manualCheckAllowed(s, s.lastAttemptAt + 300_000), true);
});
