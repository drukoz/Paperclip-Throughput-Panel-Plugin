import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrometheusText, selectSample, selectSamples } from "./parse.ts";
import { ServerKind } from "../types.ts";

test("parses a name with no labels", () => {
  const result = parsePrometheusText("up 1");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "up");
  assert.deepEqual(result[0]?.labels, {});
  assert.equal(result[0]?.value, 1);
});

test("parses labels and returns them as a record", () => {
  const result = parsePrometheusText('metric_name{a="1",b="2"} 42');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "metric_name");
  assert.deepEqual(result[0]?.labels, { a: "1", b: "2" });
  assert.equal(result[0]?.value, 42);
});

test("parses scientific notation", () => {
  const result = parsePrometheusText('vllm:prompt_tokens_total{engine="0",model_name="swift-1.5"} 2.2966279e+07');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, 22966279);
});

test("skips # HELP, # TYPE, and blank lines", () => {
  const input = [
    "# HELP vllm:generation_tokens_total Number of generation tokens.",
    "# TYPE vllm:generation_tokens_total counter",
    "",
    "vllm:generation_tokens_total 100",
    "",
  ].join("\n");
  const result = parsePrometheusText(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "vllm:generation_tokens_total");
  assert.equal(result[0]?.value, 100);
});

test("ignores a trailing timestamp field", () => {
  const result = parsePrometheusText("metric_name{a=\"1\"} 123 1699999999000");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, 123);
});

test("handles escaped quote and comma inside a quoted label value", () => {
  const input = 'm{a="he said \\"hi\\", ok",b="x"} 7';
  const result = parsePrometheusText(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "m");
  assert.equal(result[0]?.labels.a, 'he said "hi", ok');
  assert.equal(result[0]?.labels.b, "x");
  assert.equal(result[0]?.value, 7);
});

test("skips malformed lines but returns good series", () => {
  const input = [
    "good_metric 1",
    "unterminated{a=\"b",
    "no_value{a=\"b\"}",
    "good_metric2 2",
  ].join("\n");
  const result = parsePrometheusText(input);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.name, "good_metric");
  assert.equal(result[1]?.name, "good_metric2");
});

test("skips lines with a non-numeric value", () => {
  const input = [
    "good_metric 1",
    "bad_metric abc",
    'labeled{a="1"} not-a-number',
    "good_metric2 2",
  ].join("\n");
  const result = parsePrometheusText(input);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.name, "good_metric");
  assert.equal(result[1]?.name, "good_metric2");
});

test("parses +Inf and NaN", () => {
  const result = parsePrometheusText("a +Inf\nb NaN\nc -Inf");
  assert.equal(result.length, 3);
  assert.equal(result[0]?.value, Number.POSITIVE_INFINITY);
  assert.equal(Number.isNaN(result[1]?.value), true);
  assert.equal(result[2]?.value, Number.NEGATIVE_INFINITY);
});

const FIXTURE = `# HELP vllm:generation_tokens_total Number of generation tokens processed.
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{engine="0",model_name="swift-1.5"} 215684.0
vllm:prompt_tokens_total{engine="0",model_name="swift-1.5"} 2.2966279e+07
vllm:prefix_cache_hits_total{engine="0",model_name="swift-1.5"} 2.12744e+07
vllm:prefix_cache_queries_total{engine="0",model_name="swift-1.5"} 2.2966279e+07
vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="swift-1.5"} 147936.0
vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="swift-1.5"} 203544.0
vllm:num_requests_running{engine="0",model_name="swift-1.5"} 0.0
vllm:num_requests_waiting{engine="0",model_name="swift-1.5"} 0.0
vllm:kv_cache_usage_perc{engine="0",model_name="swift-1.5"} 0.0`;

test("selectSample on real excerpt returns expected numbers", () => {
  const series = parsePrometheusText(FIXTURE);
  const result = selectSample(series, { at: 1234 });
  assert.notEqual(result, null);
  assert.equal(result?.sample.generationTokens, 215684);
  assert.equal(result?.sample.promptTokens, 22966279);
  assert.equal(result?.sample.prefixCacheHits, 21274400);
  assert.equal(result?.modelName, "swift-1.5");
  assert.equal(result?.sample.at, 1234);
});

test("selectSample with mismatched modelName returns null", () => {
  const series = parsePrometheusText(FIXTURE);
  const result = selectSample(series, { at: 0, modelName: "other-model" });
  assert.equal(result, null);
});

test("selectSample sums two engines", () => {
  const input = FIXTURE + '\nvllm:generation_tokens_total{engine="1",model_name="swift-1.5"} 100.0';
  const series = parsePrometheusText(input);
  const result = selectSample(series, { at: 0 });
  assert.notEqual(result, null);
  assert.equal(result?.sample.generationTokens, 215784);
});

test("selectSample takes max of kv_cache_usage_perc across engines", () => {
  const input =
    'vllm:generation_tokens_total{engine="0",model_name="m"} 10\n' +
    'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.4\n' +
    'vllm:kv_cache_usage_perc{engine="1",model_name="m"} 0.9';
  const series = parsePrometheusText(input);
  const result = selectSample(series, { at: 0 });
  assert.notEqual(result, null);
  assert.equal(result?.sample.kvCacheUsage, 0.9);
});

test("selectSample returns null when generation counter is missing", () => {
  const input = 'vllm:prompt_tokens_total{engine="0",model_name="m"} 50';
  const series = parsePrometheusText(input);
  const result = selectSample(series, { at: 0 });
  assert.equal(result, null);
});

test("selectSample leaves kvCacheUsage null when the gauge is absent", () => {
  const input = 'vllm:generation_tokens_total{engine="0",model_name="m"} 10';
  const series = parsePrometheusText(input);
  const result = selectSample(series, { at: 0 });
  assert.equal(result?.sample.kvCacheUsage, null);
  assert.equal(result?.sample.decodeTokens, 0);
});

const LLAMA_FIXTURE = readFileSync(
  new URL("./fixtures/llamacpp-metrics.txt", import.meta.url),
  "utf8",
);

const LIVE_FIXTURE = readFileSync(
  new URL("./fixtures/live-vllm-metrics.txt", import.meta.url),
  "utf8",
);

test("selectSamples reads the llama.cpp fixture", () => {
  const series = parsePrometheusText(LLAMA_FIXTURE);
  const result = selectSamples(series, { at: 5 });
  assert.notEqual(result, null);
  assert.equal(result?.kind, ServerKind.LlamaCpp);
  assert.equal(result?.models.length, 1);
  assert.equal(result?.models[0]?.modelName, null);
  assert.deepEqual(result?.models[0]?.sample, {
    at: 5,
    generationTokens: 45678,
    promptTokens: 123456,
    prefixCacheHits: 0,
    prefixCacheQueries: 0,
    specAcceptedTokens: 600,
    specDraftTokens: 800,
    numRequestsRunning: 3,
    numRequestsWaiting: 1,
    kvCacheUsage: null,
    decodeTokens: 45678,
    decodeSeconds: 1522.6,
    firstTokenSeconds: 0,
    firstTokenCount: 0,
  });
});

test("selectSamples ignores modelName on llama.cpp", () => {
  const series = parsePrometheusText(LLAMA_FIXTURE);
  const result = selectSamples(series, { at: 5, modelName: "anything" });
  assert.notEqual(result, null);
  assert.equal(result?.kind, ServerKind.LlamaCpp);
  assert.equal(result?.models.length, 1);
  assert.equal(result?.models[0]?.modelName, null);
});

const TWO_MODELS = [
  'vllm:generation_tokens_total{engine="0",model_name="zeta"} 30',
  'vllm:generation_tokens_total{engine="0",model_name="alpha"} 10',
  'vllm:prompt_tokens_total{engine="0",model_name="alpha"} 7',
  'vllm:generation_tokens_total{engine="1",model_name="alpha"} 5',
].join("\n");

test("selectSamples splits two vLLM models, sorted by name", () => {
  const series = parsePrometheusText(TWO_MODELS);
  const result = selectSamples(series, { at: 0 });
  assert.notEqual(result, null);
  assert.equal(result?.kind, ServerKind.Vllm);
  assert.deepEqual(
    result?.models.map((m) => m.modelName),
    ["alpha", "zeta"],
  );
  const alpha = result?.models.find((m) => m.modelName === "alpha");
  const zeta = result?.models.find((m) => m.modelName === "zeta");
  assert.equal(alpha?.sample.generationTokens, 15);
  assert.equal(alpha?.sample.promptTokens, 7);
  assert.equal(zeta?.sample.generationTokens, 30);
  assert.equal(zeta?.sample.promptTokens, 0);
});

test("selectSamples keeps only the filtered vLLM model", () => {
  const series = parsePrometheusText(TWO_MODELS);
  const zeta = selectSamples(series, { at: 0, modelName: "zeta" });
  assert.notEqual(zeta, null);
  assert.equal(zeta?.kind, ServerKind.Vllm);
  assert.equal(zeta?.models.length, 1);
  assert.equal(zeta?.models[0]?.modelName, "zeta");
  const none = selectSamples(series, { at: 0, modelName: "none" });
  assert.equal(none, null);
});

test("selectSamples on the live vLLM fixture equals selectSample", () => {
  const series = parsePrometheusText(LIVE_FIXTURE);
  const result = selectSamples(series, { at: 1_700_000_000_000 });
  assert.notEqual(result, null);
  assert.equal(result?.kind, ServerKind.Vllm);
  assert.equal(result?.models.length, 1);
  assert.equal(result?.models[0]?.modelName, "swift-1.5");
  const single = selectSample(series, { at: 1_700_000_000_000, modelName: "swift-1.5" });
  assert.deepEqual(result?.models[0]?.sample, single?.sample);
});

test("selectSamples is null for unrelated metrics", () => {
  const series = parsePrometheusText("process_cpu_seconds_total 1.5");
  assert.equal(selectSamples(series, { at: 0 }), null);
});
