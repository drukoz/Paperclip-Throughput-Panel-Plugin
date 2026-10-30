import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PlanUsageReading,
  PlanUsageResult,
  PlanUsageView,
  StoredPlanUsage,
  UsageLimit,
} from "./types.ts";
import {
  PLAN_USAGE_POLL_MS,
  PLAN_USAGE_RATE_LIMITED_POLL_MS,
  RATE_LIMITED_NOTE,
  buildPlanUsageView,
  checkNote,
  mergeReadings,
  newerReading,
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

const RUN_READING: PlanUsageReading = { source: "agent_run", at: "2026-10-30T02:40:00.000Z", usage: { session: { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z" }, weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z" }, fable: null } };
const CHECK_READING: PlanUsageReading = { source: "usage_check", at: "2026-10-30T02:30:00.000Z", usage: { session: { usedPercent: 10, resetsAt: "2026-10-30T04:20:00.000Z" }, weekly: { usedPercent: 3, resetsAt: "2026-11-05T16:00:00.000Z" }, fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z" } } };
const RATE_LIMITED: PlanUsageResult = { kind: "error", message: "The provider rate limited the usage check. Try again later.", rateLimited: true };

test("newerReading returns the later reading; next wins ties and unparseable times", () => {
  assert.equal(newerReading(null, RUN_READING), RUN_READING);
  assert.equal(newerReading(RUN_READING, CHECK_READING), RUN_READING);
  assert.equal(newerReading(CHECK_READING, RUN_READING), RUN_READING);
  const tie = { ...CHECK_READING, at: RUN_READING.at };
  assert.equal(newerReading(RUN_READING, tie), tie);
  const garbage = { ...CHECK_READING, at: "garbage" };
  assert.equal(newerReading(garbage, RUN_READING), RUN_READING);
});

test("mergeReadings takes each meter from the newer reading", () => {
  assert.deepEqual(mergeReadings([RUN_READING, CHECK_READING]), {
    session: { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" },
    weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" },
    fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T02:30:00.000Z" },
  });
});

test("mergeReadings switches 5h and weekly to a newer usage check", () => {
  const newerCheck: PlanUsageReading = { ...CHECK_READING, at: "2026-10-30T03:00:00.000Z" };
  assert.deepEqual(mergeReadings([RUN_READING, newerCheck]), {
    session: { usedPercent: 10, resetsAt: "2026-10-30T04:20:00.000Z", source: "usage_check", at: "2026-10-30T03:00:00.000Z" },
    weekly: { usedPercent: 3, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T03:00:00.000Z" },
    fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T03:00:00.000Z" },
  });
});

test("mergeReadings is all null with no readings and keeps the first reading's rows on a tie", () => {
  assert.deepEqual(mergeReadings([null, null]), { session: null, weekly: null, fable: null });
  const lateCheck: PlanUsageReading = { ...CHECK_READING, at: RUN_READING.at };
  assert.deepEqual(mergeReadings([RUN_READING, lateCheck]), {
    session: { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" },
    weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" },
    fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T02:40:00.000Z" },
  });
});

test("buildPlanUsageView is loading with nothing known", () => {
  assert.deepEqual(buildPlanUsageView(null, null), { kind: "loading" });
});

test("buildPlanUsageView shows run readings as ok with no stored check", () => {
  const view = buildPlanUsageView(RUN_READING, null);
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.accountLabel, "Claude");
  assert.equal(view.checkedAt, "2026-10-30T02:40:00.000Z");
  assert.equal(view.refreshError, null);
  assert.equal(view.usage.fable, null);
  assert.deepEqual(view.usage.session, { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" });
});

test("buildPlanUsageView merges runs with the stored check and notes a rate limit", () => {
  const stored: StoredPlanUsage = { lastAttemptAt: 0, nextCheckAt: 1, good: CHECK_READING, accountLabel: "me@example.com", last: RATE_LIMITED };
  const view = buildPlanUsageView(RUN_READING, stored);
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.accountLabel, "me@example.com");
  assert.equal(view.checkedAt, "2026-10-30T02:40:00.000Z");
  assert.deepEqual(view.usage.fable, { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T02:30:00.000Z" });
  assert.equal(view.refreshError, RATE_LIMITED_NOTE);
});

test("buildPlanUsageView shows an error when there are no meters and the last check was rate limited", () => {
  const stored: StoredPlanUsage = { lastAttemptAt: 0, nextCheckAt: 1, good: null, accountLabel: null, last: RATE_LIMITED };
  assert.deepEqual(buildPlanUsageView(null, stored), {
    kind: "error",
    message: "The provider rate limited the usage check. Try again later.",
  });
});

test("buildPlanUsageView shows needs_attention and no_connection when there are no meters", () => {
  const base: StoredPlanUsage = { lastAttemptAt: 0, nextCheckAt: 1, good: null, accountLabel: null, last: null };
  assert.deepEqual(
    buildPlanUsageView(null, { ...base, last: { kind: "needs_attention", accountLabel: "me@example.com", message: "Reconnect Claude in AI connections" } }),
    { kind: "needs_attention", accountLabel: "me@example.com", message: "Reconnect Claude in AI connections" },
  );
  assert.deepEqual(buildPlanUsageView(null, { ...base, last: { kind: "no_connection" } }), { kind: "no_connection" });
});

test("buildPlanUsageView shows an ok last result with no meters as empty meters", () => {
  const stored: StoredPlanUsage = {
    lastAttemptAt: 0,
    nextCheckAt: 1,
    good: null,
    accountLabel: "me@example.com",
    last: { kind: "ok", accountLabel: "me@example.com", checkedAt: "2026-10-30T02:45:00.000Z", limits: [] },
  };
  assert.deepEqual(buildPlanUsageView(null, stored), {
    kind: "ok",
    usage: { session: null, weekly: null, fable: null },
    accountLabel: "me@example.com",
    checkedAt: "2026-10-30T02:45:00.000Z",
    refreshError: null,
  });
});

test("checkNote describes the last usage check in one line", () => {
  assert.equal(checkNote(null), null);
  assert.equal(checkNote(OK), null);
  assert.equal(checkNote({ kind: "no_connection" }), "No Claude subscription connected");
  assert.equal(checkNote({ kind: "needs_attention", accountLabel: "me@example.com", message: "Reconnect Claude in AI connections" }), "Reconnect Claude in AI connections");
  assert.equal(checkNote(RATE_LIMITED), RATE_LIMITED_NOTE);
  assert.equal(checkNote({ kind: "error", message: "boom", rateLimited: false }), "Usage check failed: boom");
});
