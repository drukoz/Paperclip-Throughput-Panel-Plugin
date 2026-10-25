import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrometheusText, selectSample } from "./parse.ts";

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
