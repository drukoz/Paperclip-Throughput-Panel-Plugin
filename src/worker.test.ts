import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import plugin, { resolveProbeSettings } from "./worker.ts";

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
    handler: (key: string) => handlers.get(key),
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

interface ProbeAccountState {
  label: string;
  last: unknown;
  lastAttemptAt: string | null;
  error: string | null;
  probing: boolean;
}

interface ProbeSnapshot {
  accounts: ProbeAccountState[];
  intervalMinutes: number;
}

test("resolveProbeSettings keeps slots with a token, trims literals and labels blank ones", () => {
  const settings = resolveProbeSettings({
    claudeAccount1Label: " A ",
    claudeAccount1Token: " tok-1\n",
    claudeAccount2Token: "",
    claudeAccount3Token: { type: "secret_ref", secretId: "s3" },
  });
  assert.deepEqual(settings.accounts, [
    { label: "A", token: "tok-1" },
    { label: "Account 3", token: { type: "secret_ref", secretId: "s3" } },
  ]);
});

test("resolveProbeSettings clamps and rounds the interval and defaults the CLI path", () => {
  assert.deepEqual(resolveProbeSettings(null), {
    accounts: [],
    claudePath: "/opt/homebrew/bin/claude",
    intervalMinutes: 15,
  });
  assert.equal(resolveProbeSettings({ claudeCheckMinutes: 2 }).intervalMinutes, 5);
  assert.equal(resolveProbeSettings({ claudeCheckMinutes: 500 }).intervalMinutes, 120);
  assert.equal(resolveProbeSettings({ claudeCheckMinutes: 7.6 }).intervalMinutes, 8);
  assert.equal(resolveProbeSettings({ claudeCheckMinutes: Number.NaN }).intervalMinutes, 15);
  assert.equal(resolveProbeSettings({ claudeCheckMinutes: "10" }).intervalMinutes, 15);
  assert.equal(resolveProbeSettings({ claudePath: "/x/claude" }).claudePath, "/x/claude");
});

test("plan-probe only reads when the panel is not active", async () => {
  const { ctx, handler } = makeCtx({
    config: {
      metricsUrl: "http://probe.local/metrics",
      claudeAccount1Label: "A",
      claudeAccount1Token: "tok-1",
      claudePath: "/nonexistent/claude-ruk518",
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response("", { status: 503 }), calls);
  try {
    await plugin.definition.setup(ctx);
    const probe = handler("plan-probe")!;
    const read = (await probe({})) as ProbeSnapshot;
    assert.deepEqual(read, {
      accounts: [{ label: "A", last: null, lastAttemptAt: null, error: null, probing: false }],
      intervalMinutes: 15,
    });
    await sleep(100);
    const second = (await probe({})) as ProbeSnapshot;
    assert.equal(second.accounts[0]!.lastAttemptAt, null);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("an active read starts a check and reports a missing CLI", async () => {
  const { ctx, handler } = makeCtx({
    config: {
      metricsUrl: "http://probe.local/metrics",
      claudeAccount1Label: "A",
      claudeAccount1Token: "tok-1",
      claudePath: "/nonexistent/claude-ruk518",
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response("", { status: 503 }), calls);
  try {
    await plugin.definition.setup(ctx);
    const probe = handler("plan-probe")!;
    await probe({ active: true });
    const deadline = Date.now() + 3000;
    let account: ProbeAccountState | undefined;
    for (;;) {
      const snap = (await probe({})) as ProbeSnapshot;
      account = snap.accounts[0];
      if (account && account.lastAttemptAt !== null && account.probing === false) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the check to finish");
      await sleep(25);
    }
    assert.match(account!.error ?? "", /^Could not start Claude Code: .*ENOENT/);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("onValidateConfig rejects a relative claudePath, an out-of-range interval and a non-string token", async () => {
  const bad = await plugin.definition.onValidateConfig!({
    claudePath: "claude",
    claudeCheckMinutes: 2,
    claudeAccount1Token: 42,
  });
  assert.equal(bad.ok, false);
  const errors = bad.errors ?? [];
  assert.ok(errors.includes("claudePath must be an absolute path"), "missing claudePath error");
  assert.ok(
    errors.includes("claudeCheckMinutes must be a number between 5 and 120"),
    "missing claudeCheckMinutes error",
  );
  assert.ok(
    errors.includes("claudeAccount1Token must be a token string or a secret reference"),
    "missing claudeAccount1Token error",
  );
  const good = await plugin.definition.onValidateConfig!({
    claudePath: "/opt/homebrew/bin/claude",
    claudeCheckMinutes: 15,
    claudeAccount1Token: "x",
    claudeAccount2Token: { type: "secret_ref", secretId: "s" },
  });
  assert.deepEqual(good, { ok: true });
});
