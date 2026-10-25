import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrometheusText, selectSample } from "./parse.ts";

const TEXT = readFileSync(
  new URL("./fixtures/live-vllm-metrics.txt", import.meta.url),
  "utf8",
);

test("live fixture parses to 493 series, 435 of them vllm:", () => {
  const series = parsePrometheusText(TEXT);
  assert.equal(series.length, 493);
  assert.equal(series.filter((s) => s.name.startsWith("vllm:")).length, 435);
});

test("live fixture sample is exact", () => {
  const series = parsePrometheusText(TEXT);
  const result = selectSample(series, { at: 1_700_000_000_000, modelName: "swift-1.5" });
  assert.notEqual(result, null);
  assert.equal(result?.modelName, "swift-1.5");
  assert.deepEqual(result?.sample, {
    at: 1_700_000_000_000,
    generationTokens: 247908,
    promptTokens: 10_947_405,
    prefixCacheHits: 9_329_600,
    prefixCacheQueries: 10_947_405,
    specAcceptedTokens: 168_431,
    specDraftTokens: 238_866,
    numRequestsRunning: 1,
    numRequestsWaiting: 0,
    kvCacheUsage: 0.09366076527698453,
  });
});

test("scientific notation becomes a plain integer", () => {
  const series = parsePrometheusText(TEXT);
  const result = selectSample(series, { at: 1_700_000_000_000, modelName: "swift-1.5" });
  assert.notEqual(result, null);
  assert.equal(result?.sample.promptTokens, 10_947_405);
  assert.notEqual(result?.sample.promptTokens, 1.0947405);
});

test("histogram buckets parse without throwing and keep their le label", () => {
  const series = parsePrometheusText(TEXT);
  const buckets = series.filter((s) => s.name.endsWith("_bucket"));
  assert.ok(buckets.length > 0, "expected at least one _bucket series");
  assert.ok(
    buckets.some((s) => s.labels.le !== undefined && s.labels.le !== ""),
    "expected a _bucket series with a non-empty le label",
  );
  const counterWithLe = series.filter(
    (s) => s.name === "vllm:generation_tokens_total" && s.labels.le !== undefined,
  );
  assert.equal(counterWithLe.length, 0);
});

test("a prefix-extended metric name is not summed into the shorter one", () => {
  const WAITING = [
    'vllm:num_requests_running{engine="0",model_name="swift-1.5"} 3.0',
    'vllm:num_requests_waiting{engine="0",model_name="swift-1.5"} 2.0',
    'vllm:num_requests_waiting_by_reason{engine="0",model_name="swift-1.5",reason="capacity"} 7.0',
    'vllm:num_requests_waiting_by_reason{engine="0",model_name="swift-1.5",reason="deferred"} 9.0',
    'vllm:generation_tokens_total{engine="0",model_name="swift-1.5"} 100.0',
  ].join("\n");
  const series = parsePrometheusText(WAITING);
  assert.ok(
    series.some((s) => s.name === "vllm:num_requests_waiting_by_reason"),
    "parser must see vllm:num_requests_waiting_by_reason as its own series",
  );
  const result = selectSample(series, { at: 0, modelName: "swift-1.5" });
  assert.notEqual(result, null);
  assert.equal(result?.sample.numRequestsWaiting, 2);
});

test("label filtering: unknown model is null, omitted model matches the single-engine fixture", () => {
  const series = parsePrometheusText(TEXT);
  const missing = selectSample(series, { at: 1, modelName: "no-such-model" });
  assert.equal(missing, null);
  const withModel = selectSample(series, { at: 1, modelName: "swift-1.5" });
  const withoutModel = selectSample(series, { at: 1 });
  assert.notEqual(withModel, null);
  assert.notEqual(withoutModel, null);
  assert.deepEqual(withoutModel?.sample, withModel?.sample);
});
