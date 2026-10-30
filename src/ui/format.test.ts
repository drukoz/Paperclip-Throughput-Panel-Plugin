import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAge, formatCount, formatPct, formatRate, formatResetIn, usageColor } from "./format.ts";

test("formatRate rounds below 1000 to an integer", () => {
  assert.equal(formatRate(0), "0");
  assert.equal(formatRate(12.4), "12");
  assert.equal(formatRate(999), "999");
});

test("formatRate uses a k suffix at 1000 and above", () => {
  assert.equal(formatRate(1000), "1.0k");
  assert.equal(formatRate(1234), "1.2k");
});

test("formatRate never returns NaN for missing values", () => {
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(undefined), "—");
  assert.equal(formatRate(NaN), "—");
  assert.equal(formatRate(Infinity), "—");
});

test("formatPct rounds to an integer with a % suffix", () => {
  assert.equal(formatPct(42.37), "42%");
  assert.equal(formatPct(0), "0%");
  assert.equal(formatPct(100), "100%");
});

test("formatPct renders the dash for missing values", () => {
  assert.equal(formatPct(null), "—");
  assert.equal(formatPct(NaN), "—");
});

test("formatCount renders integers and the dash for missing values", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(7), "7");
  assert.equal(formatCount(null), "—");
  assert.equal(formatCount(NaN), "—");
});

test("formatAge formats seconds, minutes and hours relative to now", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatAge(new Date(now - 3_000).toISOString(), now), "3s ago");
  assert.equal(formatAge(new Date(now - 120_000).toISOString(), now), "2m ago");
  assert.equal(formatAge(new Date(now - 7_200_000).toISOString(), now), "2h ago");
});

test("formatAge renders never for null and unparseable input", () => {
  assert.equal(formatAge(null, 1_700_000_000_000), "never");
  assert.equal(formatAge("nonsense", 1_700_000_000_000), "never");
});

const NOW = Date.parse("2026-10-29T16:00:00.000Z");

test("formatResetIn renders the unreported message for null and unparseable input", () => {
  assert.equal(formatResetIn(null, NOW), "reset time not reported");
  assert.equal(formatResetIn("garbage", NOW), "reset time not reported");
});

test("formatResetIn renders resets now at and before the reset time", () => {
  assert.equal(formatResetIn("2026-10-29T15:59:00.000Z", NOW), "resets now");
  assert.equal(formatResetIn("2026-10-29T16:00:00.000Z", NOW), "resets now");
});

test("formatResetIn rounds a partial minute up to 1m", () => {
  assert.equal(formatResetIn("2026-10-29T16:00:30.000Z", NOW), "resets in 1m");
});

test("formatResetIn renders minutes below an hour", () => {
  assert.equal(formatResetIn("2026-10-29T16:42:00.000Z", NOW), "resets in 42m");
});

test("formatResetIn renders hours and remaining minutes", () => {
  assert.equal(formatResetIn("2026-10-29T17:00:00.000Z", NOW), "resets in 1h 0m");
  assert.equal(formatResetIn("2026-10-29T19:14:00.000Z", NOW), "resets in 3h 14m");
  assert.equal(formatResetIn("2026-10-29T21:00:00.000Z", NOW), "resets in 5h 0m");
});

test("formatResetIn renders days and remaining hours", () => {
  assert.equal(formatResetIn("2026-10-31T20:00:00.000Z", NOW), "resets in 2d 4h");
  assert.equal(formatResetIn("2026-11-03T16:00:00.000Z", NOW), "resets in 5d 0h");
});

test("usageColor thresholds are green below 75, amber to 90, red at 90", () => {
  assert.equal(usageColor(0), "#22c55e");
  assert.equal(usageColor(74.9), "#22c55e");
  assert.equal(usageColor(75), "#f59e0b");
  assert.equal(usageColor(89.9), "#f59e0b");
  assert.equal(usageColor(90), "#ef4444");
  assert.equal(usageColor(120), "#ef4444");
});
