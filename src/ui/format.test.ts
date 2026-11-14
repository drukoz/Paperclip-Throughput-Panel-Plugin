import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAge, formatCount, formatPct, formatRate, formatResetAt, formatResetIn, formatSource, isWindowRestarted, meterDetails, nextResetAt, resetDetails, usageColor } from "./format.ts";

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

// Block scope so NOW here is this task's fixed clock, not the module-level one.
{
  const NOW = Date.parse("2026-10-30T02:44:00.000Z");

  test("formatSource names each source and renders empty for undefined", () => {
    assert.equal(formatSource("agent_run"), "from an agent run");
    assert.equal(formatSource("usage_check"), "from Anthropic's usage check");
    assert.equal(formatSource("probe"), "from a Claude Code check");
    assert.equal(formatSource(undefined), "");
  });

  test("isWindowRestarted is true only at or after a parseable reset time", () => {
    assert.equal(isWindowRestarted(null, NOW), false);
    assert.equal(isWindowRestarted("garbage", NOW), false);
    const R = "2026-10-30T04:20:00.000Z";
    assert.equal(isWindowRestarted(R, Date.parse(R) - 1), false);
    assert.equal(isWindowRestarted(R, Date.parse(R)), true);
    assert.equal(isWindowRestarted(R, Date.parse(R) + 1), true);
  });

  test("meterDetails appends the agent-run age and source", () => {
    assert.equal(
      meterDetails(
        "5h session",
        { usedPercent: 13, resetsAt: "2026-10-30T04:20:00.000Z", source: "agent_run", at: "2026-10-30T02:40:00.000Z" },
        NOW,
      ),
      "5h session: 13% used, resets in 1h 36m, as of 4m ago from an agent run",
    );
  });

  test("meterDetails appends the usage-check age and source", () => {
    assert.equal(
      meterDetails(
        "Fable weekly",
        { usedPercent: 20, resetsAt: "2026-11-05T16:00:00.000Z", source: "usage_check", at: "2026-10-30T02:32:00.000Z" },
        NOW,
      ),
      "Fable weekly: 20% used, resets in 6d 13h, as of 12m ago from Anthropic's usage check",
    );
  });

  test("meterDetails reports a restarted window with no reading since", () => {
    assert.equal(
      meterDetails(
        "Weekly",
        { usedPercent: 4, resetsAt: "2026-10-30T02:41:00.000Z", source: "agent_run", at: "2026-10-30T01:00:00.000Z" },
        NOW,
      ),
      "Weekly: window restarted 3m ago; no reading since",
    );
  });

  test("meterDetails reports no reading for a null row", () => {
    assert.equal(meterDetails("Fable weekly", null, NOW), "Fable weekly: no reading yet");
  });

  test("meterDetails omits the age and source clause when at is absent", () => {
    assert.equal(
      meterDetails("Weekly", { usedPercent: 41, resetsAt: null }, NOW),
      "Weekly: 41% used, reset time not reported",
    );
  });
}

// Block scope so NOW here is the Resets-row clock, not the module-level one.
{
  const NOW = Date.parse("2026-11-04T14:00:00.000Z");

  test("formatResetAt renders weekday, day, month and 24-hour time in the zone", () => {
    assert.equal(formatResetAt("2026-11-05T16:00:00.000Z", "UTC"), "Thu 5 Nov 16:00");
    assert.equal(formatResetAt("2026-11-05T16:00:00.000Z", "America/Mexico_City"), "Thu 5 Nov 10:00");
    assert.equal(formatResetAt("2026-11-05T16:00:00.000Z", "Asia/Kolkata"), "Thu 5 Nov 21:30");
    assert.equal(formatResetAt("2026-11-15T00:05:00.000Z", "UTC"), "Sun 15 Nov 00:05");
    assert.equal(formatResetAt("2026-11-15T23:59:00.000Z", "UTC"), "Sun 15 Nov 23:59");
  });

  test("formatResetAt renders the dash for null and unparseable input", () => {
    assert.equal(formatResetAt(null, "UTC"), "—");
    assert.equal(formatResetAt("garbage", "UTC"), "—");
  });

  test("nextResetAt takes the weekly reset, falling back to the Fable one", () => {
    const weekly = { usedPercent: 40, resetsAt: "2026-11-05T16:00:00.000Z" };
    assert.equal(nextResetAt({ session: null, weekly, fable: null }, NOW), "2026-11-05T16:00:00.000Z");
    const fable = { usedPercent: 10, resetsAt: "2026-11-06T16:00:00.000Z" };
    assert.equal(nextResetAt({ session: null, weekly: null, fable }, NOW), "2026-11-06T16:00:00.000Z");
  });

  test("nextResetAt is null for a past, unparseable or missing reset time", () => {
    const past = { usedPercent: 40, resetsAt: "2026-11-04T13:00:00.000Z" };
    assert.equal(nextResetAt({ session: null, weekly: past, fable: null }, NOW), null);
    const unknown = { usedPercent: 40, resetsAt: null };
    assert.equal(nextResetAt({ session: null, weekly: unknown, fable: null }, NOW), null);
    const garbage = { usedPercent: 40, resetsAt: "garbage" };
    assert.equal(nextResetAt({ session: null, weekly: garbage, fable: null }, NOW), null);
  });

  test("nextResetAt never falls back to the session window", () => {
    const session = { usedPercent: 5, resetsAt: "2026-11-05T16:00:00.000Z" };
    assert.equal(nextResetAt({ session, weekly: null, fable: null }, NOW), null);
  });

  test("resetDetails sentences the reset time for the Resets row", () => {
    assert.equal(resetDetails(null, NOW), "Weekly limit: next reset time not known yet");
    assert.equal(
      resetDetails("2026-11-05T16:00:00.000Z", NOW, "UTC"),
      "Weekly limit resets in 1d 2h, on Thu 5 Nov 16:00",
    );
  });
}
