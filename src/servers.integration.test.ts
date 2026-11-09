import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ServerKind, ServerStatus } from "./types.ts";
import type { ServerSnapshot, ServersSnapshot } from "./types.ts";
import plugin from "./worker.ts";

const VLLM_FIXTURE = await readFile(
  new URL("./metrics/fixtures/live-vllm-metrics.txt", import.meta.url),
  "utf8",
);
const LLAMA_FIXTURE = await readFile(
  new URL("./metrics/fixtures/llamacpp-metrics.txt", import.meta.url),
  "utf8",
);

const VLLM_GEN_LINE = 'vllm:generation_tokens_total{engine="0",model_name="swift-1.5"}';
const VLLM_GEN_RE = /^vllm:generation_tokens_total\{engine="0",model_name="swift-1.5"\}\s+\S+/m;
const LLAMA_PRED_RE = /^llamacpp:tokens_predicted_total\s+\S+/m;
const LLAMA_PRED_SECONDS_RE = /^llamacpp:tokens_predicted_seconds_total\s+\S+/m;

const TEST_TOKEN = "test-token";

/** Scraped counters: the vLLM generation tokens, and the llama.cpp predicted tokens and seconds. */
let vllmGenerationTokens = 0;
let llamaPredictedTokens = 0;
let llamaPredictedSeconds = 0;

const vllmServer = createServer((req, res) => {
  if (req.url === "/metrics") {
    const body = VLLM_FIXTURE.replace(VLLM_GEN_RE, `${VLLM_GEN_LINE} ${vllmGenerationTokens}`);
    vllmGenerationTokens += 500;
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
});

const llamaServer = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url === "/metrics") {
    const body = LLAMA_FIXTURE.replace(LLAMA_PRED_RE, `llamacpp:tokens_predicted_total ${llamaPredictedTokens}`)
      .replace(LLAMA_PRED_SECONDS_RE, `llamacpp:tokens_predicted_seconds_total ${llamaPredictedSeconds}`);
    llamaPredictedTokens += 300;
    llamaPredictedSeconds += 10;
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
    return;
  }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "swift-1.5-a9" }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

const vllmBase = await listen(vllmServer);
const llamaBase = await listen(llamaServer);

after(async () => {
  await new Promise<void>((resolve, reject) =>
    vllmServer.close((err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    llamaServer.close((err) => (err ? reject(err) : resolve())),
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal mock of the worker-side PluginContext: just config, secrets, logger and data. */
function makeCtx(options: {
  config?: Record<string, unknown> | null;
  resolveSecret?: (ref: unknown, options: unknown) => Promise<string>;
}) {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => options.config ?? null },
    http: {
      fetch: () => Promise.reject(new Error("ctx.http.fetch must not be used by the worker")),
    },
    secrets: { resolve: options.resolveSecret ?? (async () => "resolved-secret") },
    logger: { info() {}, warn() {}, error() {} },
    data: {
      register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        handlers.set(key, handler);
      },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    snapshot: async (): Promise<ServersSnapshot> => {
      const handler = handlers.get("servers");
      assert.ok(handler, "the worker must register a servers data handler");
      return (await handler({})) as ServersSnapshot;
    },
  };
}

/** Reads `snapshot()` until the servers pass `predicate`, and returns the last read. */
async function waitForServers(
  snapshot: () => Promise<ServersSnapshot>,
  predicate: (servers: ServerSnapshot[]) => boolean,
  timeoutMs = 6000,
): Promise<ServersSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await snapshot();
    if (predicate(snap.servers)) return snap;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for servers`);
    await sleep(25);
  }
}

test("both servers are read, every model named", async () => {
  const { ctx, snapshot } = makeCtx({
    config: {
      metricsUrl: `${vllmBase}/metrics`,
      server2MetricsUrl: `${llamaBase}/metrics`,
      server2Token: TEST_TOKEN,
      pollIntervalMs: 1000,
    },
  });
  try {
    await plugin.definition.setup(ctx);
    const snap = await waitForServers(
      snapshot,
      (servers) =>
        servers.length === 2 &&
        servers.every((s) => s.status === ServerStatus.Ok) &&
        servers.every((s) => s.models.length === 1) &&
        servers.every((s) => s.models.every((m) => m.instant !== null && m.modelName !== null)),
    );
    const vllm = snap.servers[0]!;
    assert.equal(vllm.slot, 1);
    assert.equal(vllm.label, "hpcserver");
    assert.equal(vllm.kind, ServerKind.Vllm);
    assert.equal(vllm.models.length, 1);
    const vllmModel = vllm.models[0]!;
    assert.equal(vllmModel.modelName, "swift-1.5");
    assert.ok((vllmModel.instant?.generation ?? 0) > 0, "vLLM instant.generation must be positive");
    assert.notEqual(vllmModel.kvCacheUsagePct, null, "vLLM kvCacheUsagePct must not be null");

    const llama = snap.servers[1]!;
    assert.equal(llama.slot, 2);
    assert.equal(llama.label, "A9 Mega");
    assert.equal(llama.kind, ServerKind.LlamaCpp);
    assert.equal(llama.models.length, 1);
    const llamaModel = llama.models[0]!;
    assert.equal(llamaModel.modelName, "swift-1.5-a9");
    assert.ok((llamaModel.instant?.generation ?? 0) > 0, "llama.cpp instant.generation must be positive");
    assert.equal(llamaModel.kvCacheUsagePct, null);
    assert.equal(llamaModel.timeToFirstTokenMs["1m"], null);
    const perRequest = llamaModel.perRequestTokensPerSec["1m"];
    assert.notEqual(perRequest, null);
    assert.ok(
      Math.abs(perRequest! - 30) < 1e-9,
      `expected perRequestTokensPerSec["1m"] within 1e-9 of 30, got ${perRequest}`,
    );
  } finally {
    await plugin.definition.onShutdown?.();
  }
});

test("the A9 without its token says so", async () => {
  const { ctx, snapshot } = makeCtx({
    config: {
      metricsUrl: `${vllmBase}/metrics`,
      server2MetricsUrl: `${llamaBase}/metrics`,
      pollIntervalMs: 1000,
    },
  });
  try {
    await plugin.definition.setup(ctx);
    const snap = await waitForServers(
      snapshot,
      (servers) =>
        servers.length === 2 &&
        servers[1]?.status === ServerStatus.Unreachable &&
        servers[0]?.status === ServerStatus.Ok,
    );
    assert.equal(snap.servers[1]!.status, ServerStatus.Unreachable);
    assert.equal(
      snap.servers[1]!.error,
      "HTTP 401 Unauthorized — set this server's token in the plugin settings",
    );
    assert.equal(snap.servers[0]!.status, ServerStatus.Ok);
  } finally {
    await plugin.definition.onShutdown?.();
  }
});

test("a secret-ref token is resolved with the company id", async () => {
  const resolves: unknown[] = [];
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: `${vllmBase}/metrics`, server2MetricsUrl: "", pollIntervalMs: 1000 },
    resolveSecret: async (_ref, options) => {
      resolves.push(options);
      return TEST_TOKEN;
    },
  });
  const config = {
    metricsUrl: `${vllmBase}/metrics`,
    server2MetricsUrl: `${llamaBase}/metrics`,
    server2Token: { type: "secret_ref", secretId: "33333333-4444-5555-6666-777777777777" },
    pollIntervalMs: 1000,
  };
  try {
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(config, { companyId: "company-1" });
    const snap = await waitForServers(
      snapshot,
      (servers) => servers.length === 2 && servers[1]?.status === ServerStatus.Ok,
    );
    assert.equal(snap.servers[1]!.status, ServerStatus.Ok);
    assert.ok(resolves.length >= 1, "expected server2Token to be resolved");
    for (const options of resolves) {
      assert.deepEqual(options, { companyId: "company-1" });
    }
  } finally {
    await plugin.definition.onShutdown?.();
  }
});

test("saving server2MetricsUrl empty hides the A9", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: `${vllmBase}/metrics`, server2MetricsUrl: "" },
  });
  try {
    await plugin.definition.setup(ctx);
    const snap = await snapshot();
    assert.equal(snap.servers.length, 1);
    assert.equal(snap.servers[0]!.slot, 1);
  } finally {
    await plugin.definition.onShutdown?.();
  }
});
