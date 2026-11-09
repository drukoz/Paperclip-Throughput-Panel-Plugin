import { test } from "node:test";
import assert from "node:assert/strict";
import type { MetricsSample, SelectedSamples } from "./types.ts";
import { ServerKind, ServerStatus } from "./types.ts";
import type { ServerPollerDeps, ServerSetting } from "./servers.ts";
import { createServerPoller, resolveServers } from "./servers.ts";

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
    kvCacheUsage: null,
    decodeTokens: 0,
    decodeSeconds: 0,
    firstTokenSeconds: 0,
    firstTokenCount: 0,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

interface Fakes {
  deps: ServerPollerDeps;
  calls: FetchCall[];
  setTime(t: number): void;
}

/** A poller's deps backed by queues of responses and selections; `now` is a settable counter. */
function makeFakes(responses: Response[], selections: (SelectedSamples | null)[]): Fakes {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const selected = [...selections];
  let time = 1_000;
  const deps: ServerPollerDeps = {
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      const res = queue.shift();
      if (res === undefined) throw new Error("fetch queue empty");
      return res;
    },
    resolveToken: async (raw) => (typeof raw === "string" ? raw : raw === null ? null : "resolved-secret"),
    select: () => {
      const entry = selected.shift();
      return entry === undefined ? null : entry;
    },
    now: () => time,
    timeoutMs: 5_000,
  };
  return { deps, calls, setTime: (t) => { time = t; } };
}

function ok(body = "# metrics"): Response {
  return new Response(body, { status: 200 });
}

function vllmScrape(at: number, names: string[]): SelectedSamples {
  return { kind: ServerKind.Vllm, models: names.map((name) => ({ modelName: name, sample: sample(at) })) };
}

function llamaScrape(at: number): SelectedSamples {
  return { kind: ServerKind.LlamaCpp, models: [{ modelName: null, sample: sample(at) }] };
}

const slot1: ServerSetting = {
  slot: 1,
  label: "hpcserver",
  metricsUrl: "http://127.0.0.1:18081/metrics",
  token: null,
  modelName: null,
};

const slot2: ServerSetting = {
  slot: 2,
  label: "A9 Mega",
  metricsUrl: "http://127.0.0.1:18082/metrics",
  token: null,
  modelName: null,
};

test("resolveServers with no config gives hpcserver, the A9 and the M5U", () => {
  const servers = resolveServers(null, {});
  assert.deepEqual(
    servers.map((s) => s.slot),
    [1, 2, 3],
  );
  assert.deepEqual(
    servers.map((s) => s.label),
    ["hpcserver", "A9 Mega", "M5U"],
  );
  assert.deepEqual(
    servers.map((s) => s.metricsUrl),
    [
      "http://127.0.0.1:18081/metrics",
      "http://127.0.0.1:18082/metrics",
      "http://127.0.0.1:18083/admin/api/activity",
    ],
  );
  assert.equal(servers[0]?.token, null);
  assert.equal(servers[2]?.token, null);
  // The A9 gets its built-in read-only metrics key (never written out in a test).
  assert.match(String(servers[1]?.token), /^[0-9a-f]{64}$/);
  for (const s of servers) assert.equal(s.modelName, null);
});

test("resolveServers sends the built-in A9 key only to the default A9 URL", () => {
  const moved = resolveServers({ server2MetricsUrl: "http://10.0.0.9:8081/metrics" }, {});
  assert.equal(moved[1]?.token, null);
  const overridden = resolveServers({ server2Token: "  my-token " }, {});
  assert.equal(overridden[1]?.token, "my-token");
});

test("resolveServers hides slot 2 when its URL is saved empty and adds slot 3 when set", () => {
  const servers = resolveServers(
    { server2MetricsUrl: "", server3MetricsUrl: " http://x:1/metrics ", server3Label: "Lab" },
    {},
  );
  assert.deepEqual(
    servers.map((s) => s.slot),
    [1, 3],
  );
  const slot3 = servers[1];
  assert.ok(slot3);
  assert.equal(slot3.metricsUrl, "http://x:1/metrics");
  assert.equal(slot3.label, "Lab");
});

test("resolveServers hides slot 3 when its URL is saved empty", () => {
  const servers = resolveServers({ server3MetricsUrl: "" }, {});
  assert.deepEqual(
    servers.map((s) => s.slot),
    [1, 2],
  );
});

test("resolveServers sends server3Token only from the settings", () => {
  const bare = resolveServers({}, {});
  assert.equal(bare[2]?.token, null);
  const withRef = resolveServers({ server3Token: { type: "secret_ref", secretId: "s" } }, {});
  assert.deepEqual(withRef[2]?.token, { type: "secret_ref", secretId: "s" });
});

test("resolveServers keeps secret refs and trims strings", () => {
  const withRef = resolveServers({ server2Token: { type: "secret_ref", secretId: "s" } }, {});
  const slot2Server = withRef.find((s) => s.slot === 2);
  assert.ok(slot2Server);
  assert.deepEqual(slot2Server.token, { type: "secret_ref", secretId: "s" });

  const trimmed = resolveServers({ authToken: "  test-token " }, {});
  assert.equal(trimmed[0]?.token, "test-token");

  const blank = resolveServers({ authToken: "   " }, {});
  assert.equal(blank[0]?.token, null);

  const filtered = resolveServers({ modelName: " m " }, {});
  assert.equal(filtered[0]?.modelName, "m");
});

test("resolveServers falls back to the environment for slot 1", () => {
  const servers = resolveServers(
    {},
    { THROUGHPUT_METRICS_URL: "http://e:1/metrics", THROUGHPUT_METRICS_TOKEN: "test-token" },
  );
  const slot1Server = servers[0];
  assert.ok(slot1Server);
  assert.equal(slot1Server.metricsUrl, "http://e:1/metrics");
  assert.equal(slot1Server.token, "test-token");
});

test("a poll sends the resolved bearer token", async () => {
  const withToken = makeFakes([ok()], [vllmScrape(1_000, ["m"])]);
  const poller = createServerPoller({ ...slot1, token: "test-token" }, withToken.deps);
  await poller.poll();
  assert.equal(withToken.calls[0]?.headers.Authorization, "Bearer test-token");

  const withoutToken = makeFakes([ok()], [vllmScrape(1_000, ["m"])]);
  const poller2 = createServerPoller(slot1, withoutToken.deps);
  await poller2.poll();
  assert.ok(withoutToken.calls[0]);
  assert.equal("Authorization" in withoutToken.calls[0].headers, false);
});

test("two vLLM models become two sorted model snapshots", async () => {
  const fakes = makeFakes([ok()], [vllmScrape(1_000, ["zeta", "alpha"])]);
  const poller = createServerPoller(slot1, fakes.deps);
  await poller.poll();
  const snap = poller.snapshot();
  assert.equal(snap.status, ServerStatus.Ok);
  assert.equal(snap.kind, ServerKind.Vllm);
  assert.deepEqual(
    snap.models.map((m) => m.modelName),
    ["alpha", "zeta"],
  );
});

test("a model missing from the next scrape is dropped", async () => {
  const fakes = makeFakes([ok(), ok()], [vllmScrape(1_000, ["alpha", "zeta"]), vllmScrape(2_000, ["alpha"])]);
  const poller = createServerPoller(slot1, fakes.deps);
  await poller.poll();
  await poller.poll();
  const snap = poller.snapshot();
  assert.deepEqual(
    snap.models.map((m) => m.modelName),
    ["alpha"],
  );
});

test("a 401 without a token says to set the token", async () => {
  const unauthorized = new Response("", { status: 401, statusText: "Unauthorized" });

  const noToken = makeFakes([unauthorized], []);
  const poller = createServerPoller(slot1, noToken.deps);
  await poller.poll();
  const snap = poller.snapshot();
  assert.equal(snap.error, "HTTP 401 Unauthorized — set this server's token in the plugin settings");
  assert.equal(snap.status, ServerStatus.Unreachable);

  const withToken = makeFakes([new Response("", { status: 401, statusText: "Unauthorized" })], []);
  const poller2 = createServerPoller({ ...slot1, token: "test-token" }, withToken.deps);
  await poller2.poll();
  assert.equal(poller2.snapshot().error, "HTTP 401 Unauthorized");
});

test("a select miss is unreachable with the URL in the error", async () => {
  const fakes = makeFakes([ok()], [null]);
  const poller = createServerPoller(slot1, fakes.deps);
  await poller.poll();
  const snap = poller.snapshot();
  assert.equal(snap.status, ServerStatus.Unreachable);
  assert.equal(snap.error, "no vLLM or llama.cpp metrics at http://127.0.0.1:18081/metrics");
});

test("a rejected fetch is unreachable and poll does not throw", async () => {
  const deps: ServerPollerDeps = {
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
    resolveToken: async () => null,
    select: () => null,
    now: () => 1_000,
    timeoutMs: 5_000,
  };
  const poller = createServerPoller(slot1, deps);
  await poller.poll();
  const snap = poller.snapshot();
  assert.equal(snap.status, ServerStatus.Unreachable);
  assert.equal(snap.error, "ECONNREFUSED");
});

test("llama.cpp takes its model name from /v1/models once a minute", async () => {
  const names = new Response(JSON.stringify({ data: [{ id: "swift-1.5-a9" }] }), { status: 200 });
  const fakes = makeFakes(
    [ok(), names, ok(), ok(), new Response(JSON.stringify({ data: [{ id: "swift-1.5-a9" }] }), { status: 200 })],
    [llamaScrape(1_000), llamaScrape(6_000), llamaScrape(61_000)],
  );
  const poller = createServerPoller(slot2, fakes.deps);
  await poller.poll();
  assert.equal(fakes.calls.length, 2);
  assert.equal(fakes.calls[1]?.url, "http://127.0.0.1:18082/v1/models");
  const snap = poller.snapshot();
  assert.equal(snap.kind, ServerKind.LlamaCpp);
  assert.equal(snap.models[0]?.modelName, "swift-1.5-a9");

  fakes.setTime(6_000);
  await poller.poll();
  assert.equal(fakes.calls.length, 3);

  fakes.setTime(61_000);
  await poller.poll();
  assert.equal(fakes.calls.length, 5);
});

test("a /v1/models failure leaves the name null", async () => {
  const fakes = makeFakes([ok(), new Response("", { status: 404 })], [llamaScrape(1_000)]);
  const poller = createServerPoller(slot2, fakes.deps);
  await poller.poll();
  assert.equal(poller.snapshot().models[0]?.modelName, null);
});

test("dispose stops an in-flight poll from writing", async () => {
  let resolveFetch: (res: Response) => void = () => {};
  const deps: ServerPollerDeps = {
    fetch: () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    resolveToken: async () => null,
    select: () => vllmScrape(1_000, ["alpha"]),
    now: () => 1_000,
    timeoutMs: 5_000,
  };
  const poller = createServerPoller(slot1, deps);
  const inflight = poller.poll();
  await new Promise((resolve) => setImmediate(resolve));
  poller.dispose();
  resolveFetch(ok());
  await inflight;
  const snap = poller.snapshot();
  assert.equal(snap.status, ServerStatus.Starting);
  assert.equal(snap.models.length, 0);
});
