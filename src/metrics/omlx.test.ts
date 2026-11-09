import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricsSample, SelectedSamples } from "../types.ts";
import { ServerKind } from "../types.ts";
import {
  parseOmlxActivity,
  parseOmlxStatus,
  OmlxCounters,
  type OmlxActivity,
  type OmlxGeneratingRow,
  type OmlxModelActivity,
  type OmlxPrefillRow,
  type OmlxStatus,
} from "./omlx.ts";

// --- helpers ---------------------------------------------------------------

function act(models: OmlxModelActivity[]): OmlxActivity {
  return { models };
}

function model(
  id: string,
  active: number,
  waiting: number,
  prefilling: OmlxPrefillRow[],
  generating: OmlxGeneratingRow[],
): OmlxModelActivity {
  return { id, activeRequests: active, waitingRequests: waiting, prefilling, generating };
}

function prefillRow(requestId: string, processed: number): OmlxPrefillRow {
  return { requestId, processed };
}

function genRow(
  requestId: string,
  generatedTokens: number,
  tokensPerSecond: number,
  promptTokens: number,
): OmlxGeneratingRow {
  return { requestId, generatedTokens, tokensPerSecond, promptTokens };
}

function st(completion: number, prompt: number, cached: number, defaultModel = "m"): OmlxStatus {
  return {
    totalCompletionTokens: completion,
    totalPromptTokens: prompt,
    totalCachedTokens: cached,
    defaultModel,
  };
}

// Assert the invariants every Scenario A/B/C call shares, then hand back the sample.
function checkCall(out: SelectedSamples, at: number, modelName: string | null): MetricsSample {
  assert.equal(out.kind, ServerKind.Omlx);
  assert.equal(out.models.length, 1);
  const ms = out.models[0]!;
  assert.equal(ms.modelName, modelName);
  const s = ms.sample;
  assert.equal(s.at, at);
  assert.equal(s.kvCacheUsage, null);
  assert.equal(s.specAcceptedTokens, 0);
  assert.equal(s.specDraftTokens, 0);
  assert.equal(s.firstTokenSeconds, 0);
  assert.equal(s.firstTokenCount, 0);
  return s;
}

// --- parseOmlxActivity -----------------------------------------------------

test("parseOmlxActivity returns null for non-activity bodies", () => {
  assert.equal(parseOmlxActivity("# HELP vllm:x"), null);
  assert.equal(parseOmlxActivity("{"), null);
  assert.equal(parseOmlxActivity('{"detail":"Not Found"}'), null);
  assert.equal(parseOmlxActivity("[]"), null);
  assert.equal(parseOmlxActivity('{"active_models":{"models":{}}}'), null);
});

test("parseOmlxActivity returns an empty model list for an empty models array", () => {
  assert.deepEqual(parseOmlxActivity('{"active_models":{"models":[]}}'), { models: [] });
});

test("parseOmlxActivity reduces the example activity body", () => {
  const body = JSON.stringify({
    active_models: {
      models: [
        {
          id: "swift15-oq8e",
          active_requests: 1,
          waiting_requests: 0,
          prefilling: [{ request_id: "r2", processed: 300, total: 500, speed: 812.4 }],
          generating: [
            { request_id: "r1", generated_tokens: 350, tokens_per_second: 50.0, prompt_tokens: 1000, elapsed_seconds: 7.0 },
          ],
        },
      ],
      total_active_requests: 1,
      total_waiting_requests: 0,
    },
  });
  assert.deepEqual(parseOmlxActivity(body), {
    models: [
      {
        id: "swift15-oq8e",
        activeRequests: 1,
        waitingRequests: 0,
        prefilling: [{ requestId: "r2", processed: 300 }],
        generating: [{ requestId: "r1", generatedTokens: 350, tokensPerSecond: 50, promptTokens: 1000 }],
      },
    ],
  });
});

test("parseOmlxActivity skips bad rows and defaults missing numbers to 0", () => {
  const body = JSON.stringify({
    active_models: {
      models: [
        { active_requests: 1 },
        {
          id: "m",
          active_requests: 1,
          waiting_requests: 2,
          prefilling: null,
          generating: [
            { generated_tokens: 5 },
            { request_id: "bad", generated_tokens: -1 },
            { request_id: "ok", generated_tokens: 5 },
          ],
        },
      ],
    },
  });
  const parsed = parseOmlxActivity(body);
  assert.deepEqual(parsed, {
    models: [
      {
        id: "m",
        activeRequests: 1,
        waitingRequests: 2,
        prefilling: [],
        generating: [{ requestId: "ok", generatedTokens: 5, tokensPerSecond: 0, promptTokens: 0 }],
      },
    ],
  });
});

// --- parseOmlxStatus -------------------------------------------------------

test("parseOmlxStatus reads the example status body", () => {
  const value = {
    status: "ok",
    default_model: "swift15-oq8e",
    total_prompt_tokens: 21000,
    total_completion_tokens: 5600,
    total_cached_tokens: 8500,
    active_requests: 0,
    waiting_requests: 0,
  };
  assert.deepEqual(parseOmlxStatus(value), {
    totalCompletionTokens: 5600,
    totalPromptTokens: 21000,
    totalCachedTokens: 8500,
    defaultModel: "swift15-oq8e",
  });
});

test("parseOmlxStatus returns null for missing, non-object, or non-count totals", () => {
  assert.equal(parseOmlxStatus(null), null);
  assert.equal(parseOmlxStatus([]), null);
  assert.equal(parseOmlxStatus({}), null);
  assert.equal(
    parseOmlxStatus({
      status: "ok",
      default_model: "swift15-oq8e",
      total_prompt_tokens: 21000,
      total_completion_tokens: 5600,
      total_cached_tokens: "x",
    }),
    null,
  );
});

test("parseOmlxStatus gives a null default model for an empty string", () => {
  const parsed = parseOmlxStatus({
    total_completion_tokens: 1,
    total_prompt_tokens: 2,
    total_cached_tokens: 3,
    default_model: "",
  });
  assert.equal(parsed?.defaultModel, null);
});

// --- Scenario A: one model, ten calls --------------------------------------

test("Scenario A drives one model's counters through live, finish, restart", () => {
  const c = new OmlxCounters();

  const s1 = checkCall(
    c.update(act([model("m", 1, 0, [], [genRow("r1", 100, 50, 1000)])]), st(5000, 20000, 8000), 1000),
    1000,
    "m",
  );
  assert.equal(s1.generationTokens, 100);
  assert.equal(s1.promptTokens, 1000);
  assert.equal(s1.decodeTokens, 100);
  assert.equal(s1.decodeSeconds, 2);
  assert.equal(s1.prefixCacheHits, 8000);
  assert.equal(s1.prefixCacheQueries, 20000);
  assert.equal(s1.numRequestsRunning, 1);
  assert.equal(s1.numRequestsWaiting, 0);

  const s2 = checkCall(
    c.update(act([model("m", 1, 2, [], [genRow("r1", 350, 50, 1000)])]), st(5000, 20000, 8000), 6000),
    6000,
    "m",
  );
  assert.equal(s2.generationTokens, 350);
  assert.equal(s2.promptTokens, 1000);
  assert.equal(s2.decodeTokens, 350);
  assert.equal(s2.decodeSeconds, 7);
  assert.equal(s2.prefixCacheHits, 8000);
  assert.equal(s2.prefixCacheQueries, 20000);
  assert.equal(s2.numRequestsRunning, 1);
  assert.equal(s2.numRequestsWaiting, 2);

  const s3 = checkCall(
    c.update(act([model("m", 0, 0, [], [])]), st(5600, 21000, 8500), 11000),
    11000,
    "m",
  );
  assert.equal(s3.generationTokens, 600);
  assert.equal(s3.promptTokens, 1000);
  assert.equal(s3.decodeTokens, 350);
  assert.equal(s3.decodeSeconds, 7);
  assert.equal(s3.prefixCacheHits, 8500);
  assert.equal(s3.prefixCacheQueries, 21000);

  const s4 = checkCall(
    c.update(act([model("m", 1, 0, [prefillRow("r2", 300)], [])]), null, 16000),
    16000,
    "m",
  );
  assert.equal(s4.generationTokens, 600);
  assert.equal(s4.promptTokens, 1300);
  assert.equal(s4.decodeTokens, 350);
  assert.equal(s4.decodeSeconds, 7);
  assert.equal(s4.prefixCacheHits, 8500);
  assert.equal(s4.prefixCacheQueries, 21000);

  const s5 = checkCall(
    c.update(act([model("m", 1, 0, [], [genRow("r2", 40, 40, 500)])]), st(5600, 21000, 8500), 21000),
    21000,
    "m",
  );
  assert.equal(s5.generationTokens, 640);
  assert.equal(s5.promptTokens, 1500);
  assert.equal(s5.decodeTokens, 390);
  assert.equal(s5.decodeSeconds, 8);
  assert.equal(s5.prefixCacheHits, 8500);
  assert.equal(s5.prefixCacheQueries, 21000);

  const s6 = checkCall(
    c.update(act([model("m", 0, 0, [], [])]), st(5680, 21500, 8500), 26000),
    26000,
    "m",
  );
  assert.equal(s6.generationTokens, 680);
  assert.equal(s6.promptTokens, 1500);
  assert.equal(s6.decodeTokens, 390);
  assert.equal(s6.decodeSeconds, 8);
  assert.equal(s6.prefixCacheHits, 8500);
  assert.equal(s6.prefixCacheQueries, 21500);

  const s7 = checkCall(
    c.update(act([model("m", 1, 0, [], [genRow("r3", 200, 100, 50)])]), st(5890, 21550, 8500), 31000),
    31000,
    "m",
  );
  assert.equal(s7.generationTokens, 890);
  assert.equal(s7.promptTokens, 1550);
  assert.equal(s7.decodeTokens, 590);
  assert.equal(s7.decodeSeconds, 10);
  assert.equal(s7.prefixCacheHits, 8500);
  assert.equal(s7.prefixCacheQueries, 21550);

  const s8 = checkCall(
    c.update(act([model("m", 0, 0, [], [])]), st(5890, 21550, 8500), 36000),
    36000,
    "m",
  );
  assert.equal(s8.generationTokens, 890);
  assert.equal(s8.promptTokens, 1550);
  assert.equal(s8.decodeTokens, 590);
  assert.equal(s8.decodeSeconds, 10);
  assert.equal(s8.prefixCacheHits, 8500);
  assert.equal(s8.prefixCacheQueries, 21550);

  const s9 = checkCall(
    c.update(act([model("m", 0, 0, [], [])]), st(0, 0, 0), 41000),
    41000,
    "m",
  );
  assert.equal(s9.generationTokens, 890);
  assert.equal(s9.promptTokens, 1550);
  assert.equal(s9.decodeTokens, 590);
  assert.equal(s9.decodeSeconds, 10);
  assert.equal(s9.prefixCacheHits, 0);
  assert.equal(s9.prefixCacheQueries, 0);

  const s10 = checkCall(
    c.update(act([model("m", 0, 0, [], [])]), st(70, 100, 0), 46000),
    46000,
    "m",
  );
  assert.equal(s10.generationTokens, 960);
  assert.equal(s10.promptTokens, 1550);
  assert.equal(s10.decodeTokens, 590);
  assert.equal(s10.decodeSeconds, 10);
  assert.equal(s10.prefixCacheHits, 0);
  assert.equal(s10.prefixCacheQueries, 100);
});

// --- Scenario B: two models ------------------------------------------------

test("Scenario B sorts two models and credits the finished request's model", () => {
  const c = new OmlxCounters();

  const b1 = c.update(
    act([model("b", 1, 0, [], [genRow("rb", 10, 10, 5)]), model("a", 0, 0, [], [])]),
    st(0, 0, 0),
    1000,
  );
  assert.equal(b1.kind, ServerKind.Omlx);
  assert.deepEqual(b1.models.map((m) => m.modelName), ["a", "b"]);

  const b2 = c.update(
    act([model("b", 0, 0, [], []), model("a", 0, 0, [], [])]),
    st(30, 5, 0),
    2000,
  );
  assert.deepEqual(b2.models.map((m) => m.modelName), ["a", "b"]);
  assert.equal(b2.models[1]!.sample.generationTokens, 30);
  assert.equal(b2.models[0]!.sample.generationTokens, 0);
});

// --- Scenario C: no model loaded -------------------------------------------

test("Scenario C emits one fallback model named after the status default", () => {
  const c = new OmlxCounters();
  const out = c.update({ models: [] }, st(0, 0, 0, "swift15-oq8e"), 1000);
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0]!.modelName, "swift15-oq8e");
  const s = out.models[0]!.sample;
  assert.equal(s.generationTokens, 0);
  assert.equal(s.promptTokens, 0);
  assert.equal(s.decodeTokens, 0);
  assert.equal(s.decodeSeconds, 0);
  assert.equal(s.numRequestsRunning, 0);
  assert.equal(s.numRequestsWaiting, 0);
});

test("Scenario C names the fallback model null when there is no status", () => {
  const c = new OmlxCounters();
  const out = c.update({ models: [] }, null, 1000);
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0]!.modelName, null);
});
