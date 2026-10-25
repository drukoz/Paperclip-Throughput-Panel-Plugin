import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import plugin from "./worker.ts";

const METRICS_OK = [
  '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
  '# TYPE vllm:generation_tokens_total counter',
  'vllm:generation_tokens_total{engine="0",model_name="test-model"} 100.0',
  'vllm:prompt_tokens_total{engine="0",model_name="test-model"} 50.0',
].join("\n");

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(25);
  }
}

/** Minimal mock of the worker-side PluginContext: just config, http, secrets, logger and data. */
function makeCtx(options: {
  config?: Record<string, unknown> | null;
  fetchImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  const calls: FetchCall[] = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => options.config ?? null },
    http: {
      fetch: (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        return options.fetchImpl
          ? Promise.resolve(options.fetchImpl(url, init))
          : Promise.resolve(new Response(METRICS_OK, { status: 200 }));
      },
    },
    secrets: { resolve: async () => "resolved-secret" },
    logger: { info() {}, warn() {}, error() {} },
    data: {
      register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        handlers.set(key, handler);
      },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    calls,
    snapshot: async (): Promise<unknown> => {
      const handler = handlers.get("throughput");
      assert.ok(handler, "the worker must register a throughput data handler");
      return handler({});
    },
  };
}

test("a rejected fetch yields unreachable and the poll loop keeps running", async () => {
  const { ctx, calls, snapshot } = makeCtx({
    config: { metricsUrl: "http://reject.local/metrics", pollIntervalMs: 1000 },
    fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  await plugin.definition.setup(ctx);
  await waitFor(() => calls.length >= 1, 2000);
  const snap = (await snapshot()) as { status: string; error: string | null };
  assert.equal(snap.status, "unreachable");
  assert.match(snap.error ?? "", /ECONNREFUSED/);
  // The rejection must not kill the interval: a second poll has to happen.
  await waitFor(() => calls.length >= 2, 5000);
  assert.ok(calls.length >= 2, "expected a second poll after the first failure");
  await plugin.definition.onShutdown?.();
});

test("a non-200 response yields unreachable with the HTTP status in the error", async () => {
  const { ctx, calls, snapshot } = makeCtx({
    config: { metricsUrl: "http://notfound.local/metrics" },
    fetchImpl: () => new Response("nope", { status: 404, statusText: "Not Found" }),
  });
  await plugin.definition.setup(ctx);
  await waitFor(() => calls.length >= 1, 2000);
  const snap = (await snapshot()) as { status: string; error: string | null };
  assert.equal(snap.status, "unreachable");
  assert.equal(snap.error, "HTTP 404 Not Found");
  await plugin.definition.onShutdown?.();
});

test("no token: the fetch carries no Authorization header", async () => {
  delete process.env.THROUGHPUT_METRICS_TOKEN;
  const { ctx, calls } = makeCtx({
    config: { metricsUrl: "http://notoken.local/metrics", modelName: "test-model" },
  });
  await plugin.definition.setup(ctx);
  await waitFor(() => calls.length >= 1, 2000);
  assert.deepEqual(calls[0]?.init?.headers, {});
  await plugin.definition.onShutdown?.();
});

test("a literal authToken is sent as a Bearer header", async () => {
  const { ctx, calls } = makeCtx({
    config: {
      metricsUrl: "http://littletoken.local/metrics",
      modelName: "test-model",
      authToken: "literal-token",
    },
  });
  await plugin.definition.setup(ctx);
  await waitFor(() => calls.length >= 1, 2000);
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer literal-token" });
  await plugin.definition.onShutdown?.();
});

test("a secret_ref authToken is resolved and sent as a Bearer header", async () => {
  const { ctx, calls } = makeCtx({
    config: {
      metricsUrl: "http://secretref.local/metrics",
      modelName: "test-model",
      // The real shape of EnvSecretRefBinding: `secretId`, not `ref`.
      authToken: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" },
    },
  });
  await plugin.definition.setup(ctx);
  await waitFor(() => calls.length >= 1, 2000);
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer resolved-secret" });
  await plugin.definition.onShutdown?.();
});
