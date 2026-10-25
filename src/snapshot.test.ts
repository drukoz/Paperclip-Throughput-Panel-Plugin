import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricsSample } from "./types.ts";
import { ThroughputWindow } from "./metrics/rates.ts";
import { buildSnapshot } from "./snapshot.ts";

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

test("status is starting before the first scrape completes", () => {
  const w = new ThroughputWindow();
  const snap = buildSnapshot({ window: w, lastError: null, started: false, modelName: null });
  assert.equal(snap.status, "starting");
  assert.equal(snap.instant, null);
  assert.equal(snap.average1m, null);
});

test("empty window with no error reports ok with no data", () => {
  const w = new ThroughputWindow();
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.status, "ok");
  assert.equal(snap.lastSampleAt, null);
  assert.deepEqual(snap.sparkline, []);
});

test("ok snapshot carries instant rates and the newer sample time", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 0 }));
  w.push(sample(5000, { generationTokens: 500 }));
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: "swift-1.5" });
  assert.equal(snap.status, "ok");
  assert.ok(snap.instant);
  assert.equal(snap.instant.generation, 100);
  assert.equal(snap.lastSampleAt, new Date(5000).toISOString());
});

test("kv cache usage is reported as a percentage", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { kvCacheUsage: 0.42 }));
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.kvCacheUsagePct, 42);
});

test("unreachable snapshot nulls point-in-time readings but keeps history", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 0 }));
  w.push(
    sample(5000, {
      generationTokens: 500,
      numRequestsRunning: 3,
      numRequestsWaiting: 1,
      kvCacheUsage: 0.42,
    }),
  );
  const snap = buildSnapshot({
    window: w,
    lastError: "boom",
    started: true,
    modelName: "swift-1.5",
  });
  assert.equal(snap.status, "unreachable");
  assert.equal(snap.error, "boom");
  assert.equal(snap.instant, null);
  assert.equal(snap.average1m, null);
  assert.equal(snap.numRequestsRunning, null);
  assert.equal(snap.numRequestsWaiting, null);
  assert.equal(snap.kvCacheUsagePct, null);
  assert.equal(snap.sparkline.length, 1);
  assert.equal(snap.lastSampleAt, new Date(5000).toISOString());
});

test("model name passes through unchanged", () => {
  const w = new ThroughputWindow();
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: "swift-1.5" });
  assert.equal(snap.modelName, "swift-1.5");
});
