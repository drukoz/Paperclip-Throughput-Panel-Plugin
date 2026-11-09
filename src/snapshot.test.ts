import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricsSample } from "./types.ts";
import { ServerStatus } from "./types.ts";
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
    decodeTokens: 0,
    decodeSeconds: 0,
    firstTokenSeconds: 0,
    firstTokenCount: 0,
    ...overrides,
  };
}

test("status is starting before the first scrape completes", () => {
  const w = new ThroughputWindow();
  const snap = buildSnapshot({ window: w, lastError: null, started: false, modelName: null });
  assert.equal(snap.status, ServerStatus.Starting);
  assert.equal(snap.instant, null);
  assert.deepEqual(snap.averages, { "1m": null, "5m": null, "15m": null });
});

test("empty window with no error reports ok with no data", () => {
  const w = new ThroughputWindow();
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.status, ServerStatus.Ok);
  assert.equal(snap.lastSampleAt, null);
  assert.deepEqual(snap.sparkline, []);
});

test("ok snapshot carries instant rates and the newer sample time", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { generationTokens: 0 }));
  w.push(sample(5000, { generationTokens: 500 }));
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: "swift-1.5" });
  assert.equal(snap.status, ServerStatus.Ok);
  assert.ok(snap.instant);
  assert.equal(snap.instant.generation, 100);
  assert.equal(snap.lastSampleAt, new Date(5000).toISOString());
});

test("ok snapshot fills every selectable average window", () => {
  const w = new ThroughputWindow();
  for (let i = 0; i < 25; i++) {
    w.push(sample(i * 5000, { generationTokens: i * 500 }));
  }
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.status, ServerStatus.Ok);
  for (const key of ["1m", "5m", "15m"] as const) {
    assert.ok(snap.averages[key]);
  }
  assert.ok(Math.abs(snap.averages["1m"]!.generation - 100) < 1);
});

test("historySpanMs is newest minus oldest, null with a single sample", () => {
  const multi = new ThroughputWindow();
  multi.push(sample(0));
  multi.push(sample(5000));
  multi.push(sample(12000));
  const multiSnap = buildSnapshot({
    window: multi,
    lastError: null,
    started: true,
    modelName: null,
  });
  assert.equal(multiSnap.historySpanMs, 12000);

  const single = new ThroughputWindow();
  single.push(sample(1000));
  const singleSnap = buildSnapshot({
    window: single,
    lastError: null,
    started: true,
    modelName: null,
  });
  assert.equal(singleSnap.historySpanMs, null);
});

test("historySpanMs is set for starting and unreachable statuses", () => {
  const w = new ThroughputWindow();
  w.push(sample(0));
  w.push(sample(5000));
  w.push(sample(12000));

  const starting = buildSnapshot({
    window: w,
    lastError: null,
    started: false,
    modelName: null,
  });
  assert.equal(starting.status, ServerStatus.Starting);
  assert.equal(starting.historySpanMs, 12000);

  const unreachable = buildSnapshot({
    window: w,
    lastError: "boom",
    started: true,
    modelName: null,
  });
  assert.equal(unreachable.status, ServerStatus.Unreachable);
  assert.equal(unreachable.historySpanMs, 12000);
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
  assert.equal(snap.status, ServerStatus.Unreachable);
  assert.equal(snap.error, "boom");
  assert.equal(snap.instant, null);
  assert.deepEqual(snap.averages, { "1m": null, "5m": null, "15m": null });
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

function pushSixtySecondsThenIdleTail(w: ThroughputWindow): void {
  for (let i = 0; i <= 12; i++) {
    w.push(sample(i * 5000, { generationTokens: i * 500 }));
  }
  for (let i = 13; i <= 37; i++) {
    w.push(sample(i * 5000, { generationTokens: 6000 }));
  }
}

test("an idle tail does not drag the snapshot averages down", () => {
  const w = new ThroughputWindow();
  pushSixtySecondsThenIdleTail(w);
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.status, ServerStatus.Ok);
  assert.equal(snap.averages["1m"]!.generation, 0);
  assert.equal(snap.averages["5m"]!.generation, 100);
  assert.equal(snap.averages["15m"]!.generation, 100);
  assert.ok(snap.instant);
  assert.equal(snap.instant.generation, 0);
  assert.equal(snap.sparkline[snap.sparkline.length - 1]!.tokensPerSec, 0);
});

test("a fully idle window reads 0, not null", () => {
  const w = new ThroughputWindow();
  w.push(sample(0));
  w.push(sample(5000));
  w.push(sample(10000));
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  assert.equal(snap.status, ServerStatus.Ok);
  for (const key of ["1m", "5m", "15m"] as const) {
    assert.ok(snap.averages[key]);
    assert.equal(snap.averages[key]!.generation, 0);
    assert.equal(snap.averages[key]!.prompt, 0);
  }
});

test("averages stay null when the status is not ok", () => {
  const w = new ThroughputWindow();
  pushSixtySecondsThenIdleTail(w);
  const starting = buildSnapshot({
    window: w,
    lastError: null,
    started: false,
    modelName: null,
  });
  assert.equal(starting.status, ServerStatus.Starting);
  assert.deepEqual(starting.averages, { "1m": null, "5m": null, "15m": null });
  const unreachable = buildSnapshot({
    window: w,
    lastError: "boom",
    started: true,
    modelName: null,
  });
  assert.equal(unreachable.status, ServerStatus.Unreachable);
  assert.deepEqual(unreachable.averages, { "1m": null, "5m": null, "15m": null });
});

test("perRequestTokensPerSec and timeToFirstTokenMs fill every window when ok", () => {
  const w = new ThroughputWindow();
  w.push(
    sample(0, { decodeTokens: 0, decodeSeconds: 0, firstTokenSeconds: 0, firstTokenCount: 0 }),
  );
  w.push(
    sample(5000, {
      decodeTokens: 150,
      decodeSeconds: 10,
      firstTokenSeconds: 1.5,
      firstTokenCount: 3,
    }),
  );
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  for (const key of ["1m", "5m", "15m"] as const) {
    assert.equal(snap.perRequestTokensPerSec[key], 15);
    assert.equal(snap.timeToFirstTokenMs[key], 500);
  }
});

test("timeToFirstTokenMs is null on a server without the metric", () => {
  const w = new ThroughputWindow();
  w.push(sample(0, { decodeTokens: 0, decodeSeconds: 0 }));
  w.push(sample(5000, { decodeTokens: 150, decodeSeconds: 10 }));
  const snap = buildSnapshot({ window: w, lastError: null, started: true, modelName: null });
  for (const key of ["1m", "5m", "15m"] as const) {
    assert.equal(snap.perRequestTokensPerSec[key], 15);
    assert.equal(snap.timeToFirstTokenMs[key], null);
  }
});

test("the new records stay null when the status is not ok", () => {
  const w = new ThroughputWindow();
  w.push(
    sample(0, { decodeTokens: 0, decodeSeconds: 0, firstTokenSeconds: 0, firstTokenCount: 0 }),
  );
  w.push(
    sample(5000, {
      decodeTokens: 150,
      decodeSeconds: 10,
      firstTokenSeconds: 1.5,
      firstTokenCount: 3,
    }),
  );
  const snap = buildSnapshot({
    window: w,
    lastError: "boom",
    started: true,
    modelName: null,
  });
  for (const key of ["1m", "5m", "15m"] as const) {
    assert.equal(snap.perRequestTokensPerSec[key], null);
    assert.equal(snap.timeToFirstTokenMs[key], null);
  }
});
