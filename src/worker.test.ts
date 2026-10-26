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

/** Wraps a fetch implementation in a `typeof fetch` stub that records every call. */
function makeFetchStub(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
  calls: FetchCall[],
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url);
    calls.push({ url: urlString, init });
    return impl(urlString, init);
  }) as typeof fetch;
}

/** Minimal mock of the worker-side PluginContext: just config, secrets, logger and data. */
function makeCtx(options: {
  config?: Record<string, unknown> | null;
}) {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => options.config ?? null },
    http: {
      // The worker must scrape with the global fetch, never the host's SSRF-
      // guarded ctx.http.fetch. Fail loudly if a regression calls this.
      fetch: () =>
        Promise.reject(new Error("ctx.http.fetch must not be used by the worker")),
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
    snapshot: async (): Promise<unknown> => {
      const handler = handlers.get("throughput");
      assert.ok(handler, "the worker must register a throughput data handler");
      return handler({});
    },
  };
}

test("a rejected fetch yields unreachable and the poll loop keeps running", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://reject.local/metrics", pollIntervalMs: 1000 },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => Promise.reject(new Error("ECONNREFUSED")),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    const snap = (await snapshot()) as { status: string; error: string | null };
    assert.equal(snap.status, "unreachable");
    assert.match(snap.error ?? "", /ECONNREFUSED/);
    // The rejection must not kill the interval: a second poll has to happen.
    await waitFor(() => calls.length >= 2, 5000);
    assert.ok(calls.length >= 2, "expected a second poll after the first failure");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a non-200 response yields unreachable with the HTTP status in the error", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://notfound.local/metrics" },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response("nope", { status: 404, statusText: "Not Found" }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    const snap = (await snapshot()) as { status: string; error: string | null };
    assert.equal(snap.status, "unreachable");
    assert.equal(snap.error, "HTTP 404 Not Found");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("no token: the fetch carries no Authorization header", async () => {
  delete process.env.THROUGHPUT_METRICS_TOKEN;
  const { ctx } = makeCtx({
    config: { metricsUrl: "http://notoken.local/metrics", modelName: "test-model" },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(METRICS_OK, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    assert.deepEqual(calls[0]?.init?.headers, {});
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a literal authToken is sent as a Bearer header", async () => {
  const { ctx } = makeCtx({
    config: {
      metricsUrl: "http://littletoken.local/metrics",
      modelName: "test-model",
      authToken: "literal-token",
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(METRICS_OK, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer literal-token" });
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a secret_ref authToken is resolved and sent as a Bearer header", async () => {
  const { ctx } = makeCtx({
    config: {
      metricsUrl: "http://secretref.local/metrics",
      modelName: "test-model",
      // The real shape of EnvSecretRefBinding: `secretId`, not `ref`.
      authToken: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" },
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(METRICS_OK, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer resolved-secret" });
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a private/reserved-range rejection leaves the snapshot unreachable and does not throw", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://127.0.0.1:18081/metrics" },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () =>
      Promise.reject(
        new Error("All resolved IPs for 127.0.0.1 are in private/reserved ranges"),
      ),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(() => calls.length >= 1, 2000);
    const snap = (await snapshot()) as { status: string; error: string | null };
    assert.equal(snap.status, "unreachable");
    assert.match(snap.error ?? "", /private\/reserved ranges/);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});
