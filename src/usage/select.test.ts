import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageLimit } from "./types.ts";
import { isAccountWide, isFableLimit, selectPlanUsage } from "./select.ts";

const FULL: UsageLimit[] = [
  { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 23 },
  { id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 41 },
  { id: "seven_day_sonnet", label: "Sonnet weekly limit", scope: "seven_day_sonnet", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 5 },
  { id: "seven_day_overage_included", label: "seven day overage included", scope: "seven_day_overage_included", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 12 },
  { id: "five_hour.scope.group%3Asession", label: "5 hour limit · session", scope: "group:session", windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 23 },
  { id: "seven_day.scope.group%3Aweekly", label: "Weekly limit · weekly", scope: "group:weekly", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 41 },
  { id: "weekly_scoped.2.scope.group%3Aweekly%7Cmodel%3AFable", label: "weekly scoped · weekly · Fable", scope: "group:weekly · model:Fable", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 12 },
  { id: "extra_usage", label: "Monthly extra usage", scope: "overage", windowDurationSeconds: null, resetsAt: null, usedPercent: null },
];

// An account whose usage has no per-model rows.
const LEGACY_ONLY: UsageLimit[] = [
  { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 64 },
  { id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 88 },
];

// A Fable row named by model id, with no group.
const MODEL_ID: UsageLimit[] = [
  { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 1 },
  { id: "weekly_scoped.0", label: "weekly scoped · claude-fable-5-1", scope: "model:claude-fable-5-1", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 7 },
];

test("selectPlanUsage picks the session, weekly and Fable meters from full limits", () => {
  assert.deepEqual(selectPlanUsage(FULL), {
    session: { usedPercent: 23, resetsAt: "2026-10-29T21:00:00.000Z" },
    weekly: { usedPercent: 41, resetsAt: "2026-11-03T16:00:00.000Z" },
    fable: { usedPercent: 12, resetsAt: "2026-11-03T16:00:00.000Z" },
  });
});

test("selectPlanUsage reads the account-wide rows when there are no per-model rows", () => {
  assert.deepEqual(selectPlanUsage(LEGACY_ONLY), {
    session: { usedPercent: 64, resetsAt: "2026-10-29T21:00:00.000Z" },
    weekly: { usedPercent: 88, resetsAt: "2026-11-03T16:00:00.000Z" },
    fable: null,
  });
});

test("selectPlanUsage counts a model-id-scoped Fable row as fable but not as weekly", () => {
  assert.deepEqual(selectPlanUsage(MODEL_ID), {
    session: { usedPercent: 1, resetsAt: "2026-10-29T21:00:00.000Z" },
    weekly: null,
    fable: { usedPercent: 7, resetsAt: "2026-11-03T16:00:00.000Z" },
  });
});

test("selectPlanUsage gives three null meters for an empty limits array", () => {
  assert.deepEqual(selectPlanUsage([]), { session: null, weekly: null, fable: null });
});

test("a Sonnet weekly bucket never counts as the weekly meter", () => {
  const limits: UsageLimit[] = [
    { id: "seven_day_sonnet", label: "Sonnet weekly limit", scope: "seven_day_sonnet", windowDurationSeconds: 604800, resetsAt: null, usedPercent: 95 },
    { id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800, resetsAt: null, usedPercent: 41 },
  ];
  assert.deepEqual(selectPlanUsage(limits).weekly, { usedPercent: 41, resetsAt: null });
});

test("the highest usedPercent wins among account-wide session windows", () => {
  const limits: UsageLimit[] = [
    { id: "five_hour_a", label: "5 hour limit a", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T20:00:00.000Z", usedPercent: 20 },
    { id: "five_hour_b", label: "5 hour limit b", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 30 },
  ];
  assert.deepEqual(selectPlanUsage(limits).session, {
    usedPercent: 30,
    resetsAt: "2026-10-29T21:00:00.000Z",
  });
});

test("a candidate whose usedPercent is null is ignored", () => {
  const limits: UsageLimit[] = [
    { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: null, usedPercent: null },
  ];
  assert.equal(selectPlanUsage(limits).session, null);
});

test("isAccountWide accepts a null scope and group-only scopes, and rejects the rest", () => {
  const withScope = (scope: string | null): UsageLimit => ({
    id: "x",
    label: "x",
    scope,
    windowDurationSeconds: 604800,
    resetsAt: null,
    usedPercent: 1,
  });
  assert.equal(isAccountWide(withScope(null)), true);
  assert.equal(isAccountWide(withScope("group:weekly")), true);
  assert.equal(isAccountWide(withScope("group:weekly · model:Fable")), false);
  assert.equal(isAccountWide(withScope("seven_day_sonnet")), false);
  assert.equal(isAccountWide(withScope("overage")), false);
});

test("isFableLimit matches fable in the label or the scope without word boundaries", () => {
  const withLabelAndScope = (label: string, scope: string | null): UsageLimit => ({
    id: "x",
    label,
    scope,
    windowDurationSeconds: 604800,
    resetsAt: null,
    usedPercent: 1,
  });
  assert.equal(isFableLimit(withLabelAndScope("weekly scoped · weekly · Fable", null)), true);
  assert.equal(isFableLimit(withLabelAndScope("weekly scoped", "model:claude-fable-5-1")), true);
  assert.equal(isFableLimit(withLabelAndScope("seven day fable", "seven_day_fable")), true);
  assert.equal(isFableLimit(withLabelAndScope("Sonnet weekly limit", "seven_day_sonnet")), false);
});
