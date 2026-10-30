import { test } from "node:test";
import assert from "node:assert/strict";
import { latestRateLimitReading, readingFromWindows, windowRow } from "./run-events.ts";

const EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1793334000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.09, resetsAt: 1793334000, status: "allowed" },
      seven_day: { utilization: 0.04, resetsAt: 1793894400, status: "allowed" },
    },
  },
  uuid: "uuid-1",
  session_id: "session-1",
};

const REAL_LINE = JSON.stringify({
  ts: "2026-10-30T02:24:32.826Z",
  attemptId: "attempt-1",
  stream: "stdout",
  chunk: JSON.stringify(EVENT) + "\n",
  seq: 77,
});

const REAL_READING = {
  source: "agent_run",
  at: "2026-10-30T02:24:32.826Z",
  usage: {
    session: { usedPercent: 9, resetsAt: "2026-10-30T04:20:00.000Z" },
    weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z" },
    fable: null,
  },
};

test("latestRateLimitReading parses a real rate_limit_event log line", () => {
  assert.deepEqual(latestRateLimitReading(REAL_LINE + "\n"), REAL_READING);
});

test("latestRateLimitReading returns the last event line", () => {
  const secondEvent = {
    ...EVENT,
    rate_limit_info: {
      ...EVENT.rate_limit_info,
      unifiedWindows: {
        five_hour: { utilization: 0.11, resetsAt: 1793334000, status: "allowed" },
        seven_day: { utilization: 0.05, resetsAt: 1793894400, status: "allowed" },
      },
    },
  };
  const secondLine = JSON.stringify({
    ts: "2026-10-30T02:30:54.505Z",
    attemptId: "attempt-1",
    stream: "stdout",
    chunk: JSON.stringify(secondEvent) + "\n",
    seq: 91,
  });
  assert.deepEqual(latestRateLimitReading(REAL_LINE + "\n" + secondLine + "\n"), {
    source: "agent_run",
    at: "2026-10-30T02:30:54.505Z",
    usage: {
      session: { usedPercent: 11, resetsAt: "2026-10-30T04:20:00.000Z" },
      weekly: { usedPercent: 5, resetsAt: "2026-11-05T16:00:00.000Z" },
      fable: null,
    },
  });
});

test("text that merely mentions rate_limit_event does not count", () => {
  const note = JSON.stringify({
    ts: "2026-10-30T02:25:00.000Z",
    attemptId: "attempt-1",
    stream: "stdout",
    chunk: '{"type":"system","subtype":"note","about":"rate_limit_event"}\n',
    seq: 78,
  });
  assert.equal(latestRateLimitReading(note + "\n"), null);
  const toolResult = JSON.stringify({
    ts: "2026-10-30T02:25:01.000Z",
    attemptId: "attempt-1",
    stream: "stdout",
    chunk:
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"grep rate_limit_event run.ndjson"}]}}\n',
    seq: 79,
  });
  assert.equal(latestRateLimitReading(toolResult + "\n"), null);
});

test("events on stderr do not count", () => {
  const line = JSON.stringify({
    ts: "2026-10-30T02:24:32.826Z",
    attemptId: "attempt-1",
    stream: "stderr",
    chunk: JSON.stringify(EVENT) + "\n",
    seq: 77,
  });
  assert.equal(latestRateLimitReading(line + "\n"), null);
});

test("cut first and last lines are skipped", () => {
  const content =
    '_event","rate_limit_info":{"status' +
    "\n" +
    REAL_LINE +
    "\n" +
    '{"ts":"2026-10-30T02:31:00.000Z","stream":"std';
  assert.deepEqual(latestRateLimitReading(content), REAL_READING);
});

test("an event sharing an entry with other stream lines is found", () => {
  const line = JSON.stringify({
    ts: "2026-10-30T02:24:32.826Z",
    attemptId: "attempt-1",
    stream: "stdout",
    chunk: '{"type":"system","subtype":"init"}\n' + JSON.stringify(EVENT) + "\n",
    seq: 77,
  });
  assert.deepEqual(latestRateLimitReading(line + "\n"), REAL_READING);
});

test("events without unifiedWindows are ignored", () => {
  const legacy = {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1793334000, rateLimitType: "five_hour" },
    uuid: "uuid-1",
    session_id: "session-1",
  };
  const line = JSON.stringify({
    ts: "2026-10-30T02:24:32.826Z",
    attemptId: "attempt-1",
    stream: "stdout",
    chunk: JSON.stringify(legacy) + "\n",
    seq: 77,
  });
  assert.equal(latestRateLimitReading(line + "\n"), null);
});

test("windowRow converts utilization and resetsAt, and rejects unusable values", () => {
  assert.deepEqual(windowRow({ utilization: 0.105, resetsAt: 1793334000 }), {
    usedPercent: 10.5,
    resetsAt: "2026-10-30T04:20:00.000Z",
  });
  assert.deepEqual(windowRow({ utilization: 0.5 }), { usedPercent: 50, resetsAt: null });
  assert.deepEqual(windowRow({ utilization: 0.5, resetsAt: 1e13 }), { usedPercent: 50, resetsAt: null });
  assert.equal(windowRow({ resetsAt: 1 }), null);
  assert.equal(windowRow(null), null);
  assert.equal(windowRow("x"), null);
  assert.equal(windowRow([]), null);
  assert.equal(windowRow({ utilization: "0.5" }), null);
});

test("readingFromWindows finds the Fable window and nulls the rest", () => {
  assert.deepEqual(
    readingFromWindows(
      { seven_day_fable: { utilization: 0.2, resetsAt: 1793894400 } },
      "2026-10-30T02:00:00.000Z",
    ),
    {
      source: "agent_run",
      at: "2026-10-30T02:00:00.000Z",
      usage: {
        session: null,
        weekly: null,
        fable: { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z" },
      },
    },
  );
  assert.equal(readingFromWindows({}, "x"), null);
});

test("empty and non-JSON content yield no reading", () => {
  assert.equal(latestRateLimitReading(""), null);
  assert.equal(latestRateLimitReading("not json\n{}\n[]\nnull\n"), null);
});
