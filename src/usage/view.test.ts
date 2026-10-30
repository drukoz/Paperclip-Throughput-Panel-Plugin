import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanUsageResult, PlanUsageView, UsageLimit } from "./types.ts";
import {
  PLAN_USAGE_POLL_MS,
  PLAN_USAGE_RATE_LIMITED_POLL_MS,
  nextPlanUsageDelayMs,
  reducePlanUsageView,
} from "./view.ts";

const LIMITS: UsageLimit[] = [
  { id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", usedPercent: 23 },
  { id: "seven_day", label: "Weekly limit", scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 41 },
  { id: "weekly_scoped.2.scope.group%3Aweekly%7Cmodel%3AFable", label: "weekly scoped · weekly · Fable", scope: "group:weekly · model:Fable", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", usedPercent: 12 },
];
const OK: PlanUsageResult = { kind: "ok", accountLabel: "owner@example.com", checkedAt: "2026-10-29T16:46:02.543Z", limits: LIMITS };

const OK_VIEW: PlanUsageView = {
  kind: "ok",
  usage: {
    session: { usedPercent: 23, resetsAt: "2026-10-29T21:00:00.000Z" },
    weekly: { usedPercent: 41, resetsAt: "2026-11-03T16:00:00.000Z" },
    fable: { usedPercent: 12, resetsAt: "2026-11-03T16:00:00.000Z" },
  },
  accountLabel: "owner@example.com",
  checkedAt: "2026-10-29T16:46:02.543Z",
  refreshError: null,
};

test("nextPlanUsageDelayMs waits 5 min for normal results and 15 min after a rate limit", () => {
  assert.equal(nextPlanUsageDelayMs(OK), PLAN_USAGE_POLL_MS);
  assert.equal(nextPlanUsageDelayMs(OK), 300000);
  assert.equal(nextPlanUsageDelayMs({ kind: "no_connection" }), 300000);
  assert.equal(
    nextPlanUsageDelayMs({ kind: "needs_attention", accountLabel: "owner@example.com", message: "Reconnect" }),
    300000,
  );
  assert.equal(nextPlanUsageDelayMs({ kind: "error", message: "boom", rateLimited: false }), 300000);
  assert.equal(nextPlanUsageDelayMs({ kind: "error", message: "slow down", rateLimited: true }), 900000);
  assert.equal(nextPlanUsageDelayMs({ kind: "error", message: "slow down", rateLimited: true }), PLAN_USAGE_RATE_LIMITED_POLL_MS);
});

test("reducePlanUsageView turns an ok result into the three meters", () => {
  assert.deepEqual(reducePlanUsageView({ kind: "loading" }, OK), {
    kind: "ok",
    usage: {
      session: { usedPercent: 23, resetsAt: "2026-10-29T21:00:00.000Z" },
      weekly: { usedPercent: 41, resetsAt: "2026-11-03T16:00:00.000Z" },
      fable: { usedPercent: 12, resetsAt: "2026-11-03T16:00:00.000Z" },
    },
    accountLabel: "owner@example.com",
    checkedAt: "2026-10-29T16:46:02.543Z",
    refreshError: null,
  });
});

test("reducePlanUsageView keeps the last good meters when rate limited", () => {
  const next = reducePlanUsageView(OK_VIEW, { kind: "error", message: "slow down", rateLimited: true });
  assert.deepEqual(next, {
    kind: "ok",
    usage: OK_VIEW.usage,
    accountLabel: OK_VIEW.accountLabel,
    checkedAt: OK_VIEW.checkedAt,
    refreshError: "Rate limited by Anthropic, retrying in 15 min",
  });
});

test("reducePlanUsageView records a plain refresh error on the ok view", () => {
  const next = reducePlanUsageView(OK_VIEW, { kind: "error", message: "Could not reach Paperclip", rateLimited: false });
  assert.equal(next.kind, "ok");
  assert.equal(next.refreshError, "Couldn't refresh: Could not reach Paperclip");
});

test("reducePlanUsageView clears the refresh error and takes the new checkedAt on a fresh ok", () => {
  const stale: PlanUsageView = { ...OK_VIEW, refreshError: "Couldn't refresh: Could not reach Paperclip" };
  const fresh: PlanUsageResult = { ...OK, checkedAt: "2026-10-29T16:51:02.543Z" };
  const next = reducePlanUsageView(stale, fresh);
  assert.equal(next.kind, "ok");
  assert.equal(next.refreshError, null);
  assert.equal(next.checkedAt, "2026-10-29T16:51:02.543Z");
});

test("reducePlanUsageView surfaces an error when there are no good meters to keep", () => {
  assert.deepEqual(reducePlanUsageView({ kind: "loading" }, { kind: "error", message: "boom", rateLimited: false }), {
    kind: "error",
    message: "boom",
  });
});

test("reducePlanUsageView switches the ok view to no_connection and needs_attention", () => {
  assert.deepEqual(reducePlanUsageView(OK_VIEW, { kind: "no_connection" }), { kind: "no_connection" });
  assert.deepEqual(
    reducePlanUsageView(OK_VIEW, { kind: "needs_attention", accountLabel: "owner@example.com", message: "Reconnect Claude in AI connections" }),
    { kind: "needs_attention", accountLabel: "owner@example.com", message: "Reconnect Claude in AI connections" },
  );
});
