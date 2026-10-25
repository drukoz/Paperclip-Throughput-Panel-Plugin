import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAge, formatCount, formatPct, formatRate } from "./format.ts";

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
