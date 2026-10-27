import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricsSample } from "../types.ts";
import { ThroughputWindow } from "./rates.ts";

function sample(at: number, overrides: Partial<MetricsSample> = {}): MetricsSample {
  return {
    at,
    generationTokens: 0,
    promptTokens: 0,
    prefixCacheHits: 0,
    prefixCacheQueries: 0,
    specAcceptedTokens: 0,
    specDraftTokens: 0,
    numRequestsRunning: 0,
    numRequestsWaiting: 0,
    kvCacheUsage: 0,
    ...overrides,
  };
}

test("empty window reports nothing", () => {
  const w = new ThroughputWindow();
  assert.equal(w.size(), 0);
  assert.equal(w.latest(), null);
  assert.equal(w.instantRates(), null);
  assert.equal(w.averageRates(), null);
  assert.deepEqual(w.sparkline(), []);
  assert.deepEqual(w.cumulativeRates(), {
    prefixCacheHitRatePct: null,
    mtpAcceptanceRatePct: null,
  });
});

test("a single sample still has no rates", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 100 }));
  assert.equal(w.size(), 1);
  assert.equal(w.latest()?.at, 0);
  assert.equal(w.instantRates(), null);
  assert.equal(w.averageRates(), null);
});

test("instant generation rate is the delta over dt", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 100 }));
  w.push(sample(5000, { generationTokens: 600 }));
  const rates = w.instantRates();
  assert.ok(rates);
  assert.equal(rates.generation, 100);
});

test("prompt rate is computed independently", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { promptTokens: 10, generationTokens: 1000 }));
  w.push(sample(2000, { promptTokens: 90, generationTokens: 1000 }));
  const rates = w.instantRates();
  assert.ok(rates);
  assert.equal(rates.prompt, 40);
  assert.equal(rates.generation, 0);
});

test("out-of-order and duplicate timestamps are ignored", () => {
  const w = new ThroughputWindow();
  w.push(sample(1000, { generationTokens: 1 }));
  w.push(sample(1000, { generationTokens: 2 }));
  assert.equal(w.size(), 1);
  w.push(sample(999, { generationTokens: 3 }));
  assert.equal(w.size(), 1);
  assert.equal(w.latest()?.generationTokens, 1);
});

test("a counter reset discards all history", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 100 }));
  w.push(sample(5000, { generationTokens: 600 }));
  w.push(sample(10000, { generationTokens: 10 }));
  assert.equal(w.size(), 1);
  assert.equal(w.latest()?.generationTokens, 10);
  assert.equal(w.instantRates(), null);
});

test("a reset on any cumulative counter discards history", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { prefixCacheHits: 500, specDraftTokens: 900 }));
  w.push(sample(5000, { prefixCacheHits: 600, specDraftTokens: 901 }));
  w.push(sample(10000, { prefixCacheHits: 1, specDraftTokens: 902 }));
  assert.equal(w.size(), 1);
  assert.equal(w.instantRates(), null);
});

test("gauge changes never trigger a reset", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { numRequestsRunning: 4, numRequestsWaiting: 7, kvCacheUsage: 0.9 }));
  w.push(sample(5000, { numRequestsRunning: 0, numRequestsWaiting: 0, kvCacheUsage: 0.1 }));
  w.push(sample(10000, { numRequestsRunning: 2, numRequestsWaiting: 1, kvCacheUsage: 0.5 }));
  assert.equal(w.size(), 3);
  assert.ok(w.instantRates());
});

test("averageRates over a uniform 60s series is 100 tok/s", () => {
  const w = new ThroughputWindow();
  for (let i = 0; i < 13; i++) {
    w.push(sample(i * 5000, { generationTokens: i * 500 }));
  }
  const avg = w.averageRates(60_000);
  assert.ok(avg);
  assert.equal(avg.generation, 100);
  const instant = w.instantRates();
  assert.ok(instant);
  assert.equal(instant.generation, 100);
});

test("averageRates smooths a spiky last interval", () => {
  const w = new ThroughputWindow();
  for (let i = 0; i < 12; i++) {
    w.push(sample(i * 5000, { generationTokens: i * 500 }));
  }
  w.push(sample(60000, { generationTokens: 11 * 500 + 5000 }));
  const instant = w.instantRates();
  assert.ok(instant);
  assert.equal(instant.generation, 1000);
  const avg = w.averageRates(60_000);
  assert.ok(avg);
  assert.equal(avg.generation, 175);
  assert.ok(avg.generation < instant.generation / 2);
});

test("averageRates falls back to the previous sample when nothing else is in the window", () => {
  const w = new ThroughputWindow({ retentionMs: 600_000 });
  w.push(sample(0, { generationTokens: 0 }));
  w.push(sample(200_000, { generationTokens: 1000 }));
  const avg = w.averageRates(60_000);
  assert.ok(avg);
  assert.equal(avg.generation, 5);
});

test("retention prunes samples older than the window", () => {
  const w = new ThroughputWindow({ retentionMs: 10_000 });
  for (const t of [0, 5000, 10000, 15000, 20000]) {
    w.push(sample(t));
  }
  assert.equal(w.size(), 3);
  assert.deepEqual(w.sparkline().map((p) => p.at), [15000, 20000]);
});

test("retention never prunes below two samples", () => {
  const w = new ThroughputWindow({ retentionMs: 1 });
  w.push(sample(0));
  w.push(sample(1000));
  assert.equal(w.size(), 2);
});

test("default retention keeps 15 minutes of history", () => {
  const w = new ThroughputWindow();
  for (const t of [0, 500_000, 900_000, 1_000_000]) {
    w.push(sample(t));
  }
  assert.equal(w.sparkline()[0]!.at, 900_000);
});

test("spanMs is null with fewer than two samples, newest minus oldest with three", () => {
  const empty = new ThroughputWindow();
  assert.equal(empty.spanMs(), null);

  const single = new ThroughputWindow();
  single.push(sample(1000));
  assert.equal(single.spanMs(), null);

  const w = new ThroughputWindow();
  w.push(sample(0));
  w.push(sample(5000));
  w.push(sample(12000));
  assert.equal(w.spanMs(), 12000);
});

test("cumulative rates are percentages of the latest sample", () => {
  const w = new ThroughputWindow();
  w.push(
    sample(0, {
      prefixCacheHits: 75,
      prefixCacheQueries: 100,
      specAcceptedTokens: 3,
      specDraftTokens: 4,
    }),
  );
  assert.deepEqual(w.cumulativeRates(), {
    prefixCacheHitRatePct: 75,
    mtpAcceptanceRatePct: 75,
  });
});

test("cumulative rates are null on a zero denominator and clamp to 100", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { prefixCacheHits: 5, specAcceptedTokens: 2 }));
  assert.deepEqual(w.cumulativeRates(), {
    prefixCacheHitRatePct: null,
    mtpAcceptanceRatePct: null,
  });
  w.push(sample(5000, { prefixCacheHits: 150, prefixCacheQueries: 100 }));
  const rates = w.cumulativeRates();
  assert.equal(rates.prefixCacheHitRatePct, 100);
  assert.equal(rates.mtpAcceptanceRatePct, null);
});

test("sparkline has one point per interval, oldest first", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 0 }));
  w.push(sample(1000, { generationTokens: 100 }));
  w.push(sample(2000, { generationTokens: 300 }));
  w.push(sample(3000, { generationTokens: 300 }));
  assert.deepEqual(w.sparkline(), [
    { at: 1000, tokensPerSec: 100 },
    { at: 2000, tokensPerSec: 200 },
    { at: 3000, tokensPerSec: 0 },
  ]);
});

test("rates clamp at zero when only gauges move", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 100, promptTokens: 50, numRequestsRunning: 4 }));
  w.push(sample(5000, { generationTokens: 100, promptTokens: 50, numRequestsRunning: 0 }));
  const rates = w.instantRates();
  assert.ok(rates);
  assert.equal(rates.generation, 0);
  assert.equal(rates.prompt, 0);
});
