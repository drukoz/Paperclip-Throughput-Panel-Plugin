import { test } from "node:test";
import assert from "node:assert/strict";
import { averageTitle, pointsInWindow, windowCaption } from "./window.ts";

test("pointsInWindow returns an empty array for no points", () => {
  assert.deepEqual(pointsInWindow([], 60_000), []);
});

test("pointsInWindow drops points before the cutoff, keeping the cutoff point", () => {
  const points = [
    { at: 0, tokensPerSec: 10 },
    { at: 30_000, tokensPerSec: 12 },
    { at: 60_000, tokensPerSec: 11 },
    { at: 90_000, tokensPerSec: 13 },
  ];
  assert.deepEqual(pointsInWindow(points, 60_000), [
    { at: 30_000, tokensPerSec: 12 },
    { at: 60_000, tokensPerSec: 11 },
    { at: 90_000, tokensPerSec: 13 },
  ]);
});

test("pointsInWindow keeps every point when the window exceeds the history, oldest first", () => {
  const points = [
    { at: 0, tokensPerSec: 10 },
    { at: 30_000, tokensPerSec: 12 },
    { at: 60_000, tokensPerSec: 11 },
  ];
  const kept = pointsInWindow(points, 900_000);
  assert.deepEqual(kept, points);
  assert.equal(kept[0]?.at, 0);
  assert.equal(kept[kept.length - 1]?.at, 60_000);
});

test("windowCaption describes each selectable window", () => {
  assert.equal(windowCaption("1m"), "last 1 min");
  assert.equal(windowCaption("5m"), "last 5 min");
  assert.equal(windowCaption("15m"), "last 15 min");
});

test("averageTitle notes when history is shorter than the window", () => {
  assert.equal(
    averageTitle("5m", 40_000),
    "only 40s of history so far, idle time excluded",
  );
});

test("averageTitle reports the trailing average for full and unknown history", () => {
  assert.equal(averageTitle("5m", 600_000), "trailing 5m average, idle time excluded");
  assert.equal(averageTitle("5m", null), "trailing 5m average, idle time excluded");
});
