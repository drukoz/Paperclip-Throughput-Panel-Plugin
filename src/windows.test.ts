import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVERAGE_WINDOW_KEYS,
  AVERAGE_WINDOW_MS,
  MAX_AVERAGE_WINDOW_MS,
  isAverageWindowKey,
} from "./windows.ts";

test("the window keys are 1m, 5m and 15m in that order", () => {
  assert.deepEqual(AVERAGE_WINDOW_KEYS, ["1m", "5m", "15m"]);
});

test("every window key has a positive length in ms", () => {
  for (const key of AVERAGE_WINDOW_KEYS) {
    assert.ok(AVERAGE_WINDOW_MS[key] > 0);
  }
});

test("the window lengths are 60s, 5min and 15min in ms", () => {
  assert.equal(AVERAGE_WINDOW_MS["1m"], 60_000);
  assert.equal(AVERAGE_WINDOW_MS["5m"], 300_000);
  assert.equal(AVERAGE_WINDOW_MS["15m"], 900_000);
});

test("MAX_AVERAGE_WINDOW_MS is the largest window length", () => {
  const largest = Math.max(...AVERAGE_WINDOW_KEYS.map((key) => AVERAGE_WINDOW_MS[key]));
  assert.equal(MAX_AVERAGE_WINDOW_MS, largest);
  assert.equal(MAX_AVERAGE_WINDOW_MS, 900_000);
});

test("isAverageWindowKey is true for each key", () => {
  for (const key of AVERAGE_WINDOW_KEYS) {
    assert.equal(isAverageWindowKey(key), true);
  }
});

test("isAverageWindowKey is false for anything else", () => {
  assert.equal(isAverageWindowKey("30m"), false);
  assert.equal(isAverageWindowKey(""), false);
  assert.equal(isAverageWindowKey(null), false);
  assert.equal(isAverageWindowKey(undefined), false);
  assert.equal(isAverageWindowKey(5), false);
  assert.equal(isAverageWindowKey({}), false);
});
