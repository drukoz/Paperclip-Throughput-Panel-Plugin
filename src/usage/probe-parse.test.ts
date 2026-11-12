import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbeOutput } from "./probe-parse.ts";
import type { ProbeObservation, ProbeParseResult } from "./probe-types.ts";

const AT = "2026-11-04T01:13:44.704Z";

const SYSTEM_LINE =
  '{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"s1","tools":[],"claude_code_version":"2.1.318","apiKeySource":"none"}';
const EVENT_SEVEN_DAY_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1793894400,"rateLimitType":"seven_day","utilization":0.96,"overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"seven_day":{"utilization":0.96,"resetsAt":1793894400,"status":"allowed_warning","surpassedThreshold":0.75}}},"uuid":"u1","session_id":"s1"}';
const ASSISTANT_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"s1"}';
const RESULT_OK_LINE =
  '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"s1"}';
const EVENT_BOTH_WINDOWS_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793334000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.09,"resetsAt":1793334000,"status":"allowed"},"seven_day":{"utilization":0.04,"resetsAt":1793894400,"status":"allowed"}}},"uuid":"u2","session_id":"s2"}';
const RESULT_ERROR_LINE =
  '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Fix external API key","session_id":"s1"}';

const STDOUT_218 = [SYSTEM_LINE, EVENT_SEVEN_DAY_LINE, ASSISTANT_LINE, RESULT_OK_LINE].join("\n");

const OK_218 = {
  kind: "ok",
  observation: {
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
  },
};

/** Asserts the result is ok and returns its observation. */
function okObservation(result: ProbeParseResult): ProbeObservation {
  if (result.kind !== "ok") {
    assert.fail(`expected an ok result, got the error "${result.message}"`);
  }
  return result.observation;
}

test("a seven_day-only event gives the weekly meter and no 5-hour or Fable meter", () => {
  assert.deepEqual(parseProbeOutput(STDOUT_218, AT), OK_218);
});

test("an event with both windows gives the 5-hour and weekly meters", () => {
  const observation = okObservation(parseProbeOutput(EVENT_BOTH_WINDOWS_LINE, AT));
  assert.deepEqual(observation.reading, {
    source: "probe",
    at: AT,
    usage: {
      session: { usedPercent: 9, resetsAt: "2026-10-30T04:20:00.000Z" },
      weekly: { usedPercent: 4, resetsAt: "2026-11-05T16:00:00.000Z" },
      fable: null,
    },
  });
  assert.equal(observation.status, "allowed");
  assert.equal(observation.rateLimitType, "five_hour");
});

test("the last rate_limit_event wins", () => {
  const first =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.5,"resetsAt":1793894400,"status":"allowed"}}},"uuid":"u1","session_id":"s1"}';
  const second =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.6,"resetsAt":1793894400,"status":"allowed"}}},"uuid":"u2","session_id":"s1"}';
  const observation = okObservation(parseProbeOutput([first, second].join("\n"), AT));
  assert.equal(observation.reading.usage.weekly?.usedPercent, 60);
});

test("an event without unifiedWindows falls back to its top-level window", () => {
  const line =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1793894400,"rateLimitType":"seven_day","utilization":1}}';
  const observation = okObservation(parseProbeOutput(line, AT));
  assert.deepEqual(observation.reading.usage.weekly, {
    usedPercent: 100,
    resetsAt: "2026-11-05T16:00:00.000Z",
  });
  assert.equal(observation.status, "rejected");
  assert.equal(observation.overageStatus, null);
  assert.equal(observation.overageDisabledReason, null);
});

test("an event with no usable window is an error", () => {
  const noWindow = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}';
  assert.deepEqual(parseProbeOutput(noWindow, AT), {
    kind: "error",
    message: "Claude Code reported no usage figures",
  });
  const stringUtilization =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day":{"utilization":"0.5","resetsAt":1793894400,"status":"allowed"}}}}';
  assert.deepEqual(parseProbeOutput(stringUtilization, AT), {
    kind: "error",
    message: "Claude Code reported no usage figures",
  });
});

test("an error result without an event gives Claude Code's error text", () => {
  assert.deepEqual(parseProbeOutput(RESULT_ERROR_LINE, AT), {
    kind: "error",
    message: "Claude Code: Invalid API key · Fix external API key",
  });
});

test("a long error text is cut to 200 characters", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "x".repeat(500),
  });
  assert.deepEqual(parseProbeOutput(line, AT), {
    kind: "error",
    message: "Claude Code: " + "x".repeat(200),
  });
});

test("a successful result without an event", () => {
  assert.deepEqual(parseProbeOutput(RESULT_OK_LINE, AT), {
    kind: "error",
    message: "Claude Code answered without a usage report",
  });
});

test("empty or unreadable output", () => {
  for (const stdout of ["", "not json\n{broken", '[1,2]\nnull\n"text"']) {
    assert.deepEqual(parseProbeOutput(stdout, AT), {
      kind: "error",
      message: "Claude Code printed no usage report",
    });
  }
});

test("text that only quotes rate_limit_event is ignored", () => {
  const quoted = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"type":"rate_limit_event"}' }],
    },
  });
  assert.deepEqual(parseProbeOutput([quoted, RESULT_OK_LINE].join("\n"), AT), {
    kind: "error",
    message: "Claude Code answered without a usage report",
  });
});

test("a resetsAt beyond Date's range gives a null reset time", () => {
  const line =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.5,"resetsAt":1e20,"status":"allowed"}}}}';
  const observation = okObservation(parseProbeOutput(line, AT));
  assert.deepEqual(observation.reading.usage.weekly, { usedPercent: 50, resetsAt: null });
});

test("Windows line endings are accepted", () => {
  const stdout = [SYSTEM_LINE, EVENT_SEVEN_DAY_LINE, ASSISTANT_LINE, RESULT_OK_LINE].join("\r\n");
  assert.deepEqual(parseProbeOutput(stdout, AT), OK_218);
});
