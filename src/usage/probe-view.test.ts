import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProbeAccountState, ProbeObservation } from "./probe-types.ts";
import { LIMIT_REACHED_NOTE, probeAccountView, probeNote } from "./probe-view.ts";

const AT = "2026-11-04T01:13:44.704Z";

const OBS: ProbeObservation = {
  reading: {
    source: "probe",
    at: AT,
    usage: {
      session: null,
      weekly: { usedPercent: 96, resetsAt: "2026-11-05T16:00:00.000Z" },
      fable: null,
    },
  },
  status: "allowed_warning",
  rateLimitType: "seven_day",
  overageStatus: "rejected",
  overageDisabledReason: "out_of_credits",
};

const base: ProbeAccountState = { label: "A", last: null, lastAttemptAt: null, error: null, probing: false };

test("an account with no check yet is loading", () => {
  assert.deepStrictEqual(probeAccountView(base), { kind: "loading" });
});

test("an account whose only attempt failed shows the error", () => {
  assert.deepStrictEqual(probeAccountView({ ...base, error: "Claude Code: Invalid API key" }), {
    kind: "error",
    message: "Claude Code: Invalid API key",
  });
});

test("an observed account is an ok view with source probe on every meter", () => {
  assert.deepStrictEqual(probeAccountView({ ...base, last: OBS }), {
    kind: "ok",
    usage: {
      session: null,
      weekly: { usedPercent: 96, resetsAt: "2026-11-05T16:00:00.000Z", source: "probe", at: AT },
      fable: null,
    },
    accountLabel: "A",
    checkedAt: AT,
    refreshError: null,
  });
});

test("a failed later check keeps the meters and notes the failure", () => {
  const view = probeAccountView({ ...base, last: OBS, error: "Claude Code did not answer in time" });
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.deepStrictEqual(view.usage.weekly, {
    usedPercent: 96,
    resetsAt: "2026-11-05T16:00:00.000Z",
    source: "probe",
    at: AT,
  });
  assert.equal(view.refreshError, "Last check failed: Claude Code did not answer in time");
});

test("a rejected status notes that the limit is reached", () => {
  const view = probeAccountView({ ...base, last: { ...OBS, status: "rejected" } });
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.refreshError, LIMIT_REACHED_NOTE);
});

test("a reading with both windows has no note", () => {
  const last: ProbeObservation = {
    ...OBS,
    reading: {
      ...OBS.reading,
      usage: {
        session: { usedPercent: 9, resetsAt: null },
        weekly: OBS.reading.usage.weekly,
        fable: null,
      },
    },
  };
  const view = probeAccountView({ ...base, last });
  assert.equal(view.kind, "ok");
  if (view.kind !== "ok") return;
  assert.equal(view.refreshError, null);
  assert.deepStrictEqual(view.usage.session, { usedPercent: 9, resetsAt: null, source: "probe", at: AT });
});

test("probeNote is null for an account with no check yet", () => {
  assert.equal(probeNote(base), null);
});
