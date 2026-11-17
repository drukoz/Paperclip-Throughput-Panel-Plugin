import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ServerKind, ServerStatus } from "./types.ts";
import type { ServerSnapshot, ServersSnapshot } from "./types.ts";
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
  getConfig?: (companyId?: string) => Promise<Record<string, unknown> | null>;
  resolveSecret?: (ref: unknown, options: unknown) => Promise<string>;
}) {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: options.getConfig ?? (async () => options.config ?? null) },
    http: {
      // The worker must scrape with the global fetch, never the host's SSRF-
      // guarded ctx.http.fetch. Fail loudly if a regression calls this.
      fetch: () =>
        Promise.reject(new Error("ctx.http.fetch must not be used by the worker")),
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
    handler: (key: string) => handlers.get(key),
    snapshot: async (): Promise<unknown> => {
      const handler = handlers.get("servers");
      assert.ok(handler, "the worker must register a servers data handler");
      return handler({});
    },
  };
}

/** Reads `snapshot()` until the servers pass `predicate`, and returns the last read. */
async function waitForServers(
  snapshot: () => Promise<unknown>,
  predicate: (servers: ServerSnapshot[]) => boolean,
  timeoutMs = 2000,
): Promise<ServersSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = (await snapshot()) as ServersSnapshot;
    if (predicate(snap.servers)) return snap;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for servers`);
    await sleep(25);
  }
}

test("a rejected fetch yields unreachable and the poll loop keeps running", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://reject.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "", pollIntervalMs: 1000 },
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
    const server = (await snapshot() as ServersSnapshot).servers[0]!;
    assert.equal(server.status, ServerStatus.Unreachable);
    assert.match(server.error ?? "", /ECONNREFUSED/);
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
    config: { metricsUrl: "http://notfound.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "" },
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
    const server = (await snapshot() as ServersSnapshot).servers[0]!;
    assert.equal(server.status, ServerStatus.Unreachable);
    assert.equal(server.error, "HTTP 404 Not Found");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("no token: the fetch carries no Authorization header", async () => {
  delete process.env.THROUGHPUT_METRICS_TOKEN;
  const { ctx } = makeCtx({
    config: { metricsUrl: "http://notoken.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "", modelName: "test-model" },
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
      server2MetricsUrl: "",
      server3MetricsUrl: "",
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
      server2MetricsUrl: "",
      server3MetricsUrl: "",
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
    config: { metricsUrl: "http://127.0.0.1:18081/metrics", server2MetricsUrl: "", server3MetricsUrl: "" },
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
    const server = (await snapshot() as ServersSnapshot).servers[0]!;
    assert.equal(server.status, ServerStatus.Unreachable);
    assert.match(server.error ?? "", /private\/reserved ranges/);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("the default config polls hpcserver, the A9 and the M5U", async () => {
  const { ctx, snapshot } = makeCtx({ config: {} });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(METRICS_OK, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await waitFor(
      () =>
        calls.some((c) => c.url === "http://127.0.0.1:18081/metrics") &&
        calls.some((c) => c.url === "http://127.0.0.1:18082/metrics") &&
        calls.some((c) => c.url === "http://127.0.0.1:18083/metrics"),
      2000,
    );
    const snap = (await snapshot()) as ServersSnapshot;
    assert.deepEqual(
      snap.servers.map((s) => s.slot),
      [1, 2, 3],
    );
    assert.deepEqual(
      snap.servers.map((s) => s.label),
      ["hpcserver", "A9 Mega", "M5U"],
    );
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("every model on a vLLM server is listed", async () => {
  const metrics = `${METRICS_OK}\nvllm:generation_tokens_total{engine="0",model_name="other-model"} 5.0`;
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://twomodels.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "" },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(metrics, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    const snap = await waitForServers(snapshot, (servers) => (servers[0]?.models.length ?? 0) > 0);
    assert.deepEqual(
      snap.servers[0]!.models.map((m) => m.modelName),
      ["other-model", "test-model"],
    );
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a llama.cpp server is read", async () => {
  const { ctx, snapshot } = makeCtx({
    config: { metricsUrl: "http://llama.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "" },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub((url) => {
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "swift-1.5-a9" }] }), { status: 200 });
    }
    return new Response("llamacpp:tokens_predicted_total 10\nllamacpp:prompt_tokens_total 4", { status: 200 });
  }, calls);
  try {
    await plugin.definition.setup(ctx);
    const snap = await waitForServers(
      snapshot,
      (servers) => servers[0]?.models.some((m) => m.modelName !== null) ?? false,
    );
    assert.equal(snap.servers[0]!.kind, ServerKind.LlamaCpp);
    assert.equal(snap.servers[0]!.models[0]!.modelName, "swift-1.5-a9");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("server2Token as a secret is resolved with the company id", async () => {
  const resolves: unknown[] = [];
  const { ctx } = makeCtx({
    config: { metricsUrl: "http://one.local/metrics", server2MetricsUrl: "", server3MetricsUrl: "" },
    resolveSecret: async (_ref, options) => {
      resolves.push(options);
      return "resolved-secret";
    },
  });
  const config = {
    metricsUrl: "http://one.local/metrics",
    server2MetricsUrl: "http://two.local/metrics",
    server3MetricsUrl: "",
    server2Token: { type: "secret_ref", secretId: "22222222-3333-4444-5555-666666666666" },
  };
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(
    () => new Response(METRICS_OK, { status: 200 }),
    calls,
  );
  try {
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(config, { companyId: "company-1" });
    await waitFor(() => calls.some((c) => c.url === "http://two.local/metrics"), 2000);
    const two = calls.find((c) => c.url === "http://two.local/metrics")!;
    assert.deepEqual(two.init?.headers, { Authorization: "Bearer resolved-secret" });
    assert.ok(resolves.length >= 1, "expected server2Token to be resolved");
    for (const options of resolves) {
      assert.deepEqual(options, { companyId: "company-1" });
    }
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("onValidateConfig accepts an empty server2MetricsUrl and rejects a bad server3MetricsUrl", async () => {
  const good = await plugin.definition.onValidateConfig!({ server2MetricsUrl: "" });
  assert.deepEqual(good, { ok: true });
  const bad = await plugin.definition.onValidateConfig!({ server3MetricsUrl: "not a url" });
  assert.equal(bad.ok, false);
  assert.ok(
    (bad.errors ?? []).includes('server3MetricsUrl is not a valid URL: "not a url"'),
    "missing server3MetricsUrl error",
  );
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
      server3MetricsUrl: "",
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
      server3MetricsUrl: "",
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

const REF_A = { type: "secret_ref", secretId: "11111111-2222-4333-8444-555555555555", version: "latest" };

async function waitForProbeRead(
  probe: (params: Record<string, unknown>) => Promise<unknown>,
  accountCount: number,
): Promise<ProbeSnapshot> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const snap = (await probe({})) as ProbeSnapshot;
    if (
      snap.accounts.length === accountCount &&
      snap.accounts.every((a) => a.lastAttemptAt !== null && a.probing === false)
    ) {
      return snap;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the check to finish");
    await sleep(25);
  }
}

test("a secret token is resolved with the company id from onConfigChanged", async () => {
  const resolves: { ref: unknown; options: unknown }[] = [];
  const { ctx, handler } = makeCtx({
    config: { metricsUrl: "http://probe.local/metrics", server3MetricsUrl: "" },
    resolveSecret: async (ref, options) => {
      resolves.push({ ref, options });
      return "tok-from-secret";
    },
  });
  const config = {
    metricsUrl: "http://probe.local/metrics",
    server3MetricsUrl: "",
    claudeAccount1Label: "A",
    claudeAccount1Token: REF_A,
    claudePath: "/nonexistent/claude-ruk518",
  };
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response("", { status: 503 }), calls);
  try {
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(config, { companyId: "company-1" });
    const probe = handler("plan-probe")!;
    await probe({ active: true });
    const snap = await waitForProbeRead(probe, 1);
    assert.deepEqual(resolves, [{ ref: REF_A, options: { companyId: "company-1" } }]);
    assert.match(snap.accounts[0]!.error ?? "", /^Could not start Claude Code: .*ENOENT/);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a check started inside a request runs outside it", async () => {
  const request = new AsyncLocalStorage<string>();
  const stores: (string | undefined)[] = [];
  const { ctx, handler } = makeCtx({
    config: { metricsUrl: "http://probe.local/metrics", server3MetricsUrl: "" },
    resolveSecret: async () => {
      stores.push(request.getStore());
      return "tok-from-secret";
    },
  });
  const config = {
    metricsUrl: "http://probe.local/metrics",
    server3MetricsUrl: "",
    claudeAccount1Label: "A",
    claudeAccount1Token: REF_A,
    claudeAccount2Label: "B",
    claudeAccount2Token: { type: "secret_ref", secretId: "66666666-7777-4888-8999-000000000000", version: "latest" },
    claudePath: "/nonexistent/claude-ruk518",
  };
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response("", { status: 503 }), calls);
  try {
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(config, { companyId: "company-1" });
    await request.run("inv-1", () => handler("plan-probe")!({ active: true }));
    await waitForProbeRead(handler("plan-probe")!, 2);
    assert.deepEqual(stores, [undefined, undefined]);
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("after a restart without replayed settings, a servers request with the company loads them and sends the M5U key", async () => {
  const resolves: unknown[] = [];
  const { ctx, handler } = makeCtx({
    getConfig: async (companyId?: string) => {
      if (companyId === undefined) throw new Error("company context is required");
      return {
        metricsUrl: "http://one.local/metrics",
        server2MetricsUrl: "",
        server3MetricsUrl: "http://m5u.local/admin/api/activity",
        server3Token: { type: "secret_ref", secretId: "33333333-4444-4555-8666-777777777777" },
      };
    },
    resolveSecret: async (_ref, options) => {
      resolves.push(options);
      return "m5u-key";
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response(METRICS_OK, { status: 200 }), calls);
  try {
    await plugin.definition.setup(ctx);
    await handler("servers")!({ companyId: "company-1" });
    await waitFor(() => calls.some((c) => c.url === "http://m5u.local/admin/api/activity"), 2000);
    const m5u = calls.find((c) => c.url === "http://m5u.local/admin/api/activity")!;
    assert.deepEqual(m5u.init?.headers, { Authorization: "Bearer m5u-key" });
    assert.ok(resolves.length >= 1, "expected the M5U token to be resolved");
    for (const options of resolves) {
      assert.deepEqual(options, { companyId: "company-1" });
    }
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("a servers request without a company does not ask the host for settings", async () => {
  let getConfigCalls = 0;
  const { ctx, handler } = makeCtx({
    getConfig: async (companyId?: string) => {
      getConfigCalls += 1;
      void companyId;
      return null;
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response(METRICS_OK, { status: 200 }), calls);
  try {
    await plugin.definition.setup(ctx);
    assert.equal(getConfigCalls, 1, "setup reads the config once");
    await handler("servers")!({});
    assert.equal(getConfigCalls, 1, "a request without a company must not ask the host for settings");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("the settings load is not retried within a minute after a failure", async () => {
  const companyLoads: (string | undefined)[] = [];
  const { ctx, handler } = makeCtx({
    getConfig: async (companyId?: string) => {
      companyLoads.push(companyId);
      throw new Error("host unavailable");
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response(METRICS_OK, { status: 200 }), calls);
  try {
    await plugin.definition.setup(ctx);
    await handler("servers")!({ companyId: "company-1" });
    await handler("servers")!({ companyId: "company-1" });
    const companyLoadsForOne = companyLoads.filter((c) => c === "company-1");
    assert.equal(companyLoadsForOne.length, 1, "a failed load is retried at most once per minute");
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});

test("secrets for polls started by a request-time load run outside that request", async () => {
  const request = new AsyncLocalStorage<string>();
  const stores: (string | undefined)[] = [];
  const { ctx, handler } = makeCtx({
    getConfig: async (companyId?: string) => {
      if (companyId === undefined) throw new Error("company context is required");
      return {
        metricsUrl: "http://one.local/metrics",
        server2MetricsUrl: "",
        server3MetricsUrl: "http://m5u.local/admin/api/activity",
        server3Token: { type: "secret_ref", secretId: "33333333-4444-4555-8666-777777777777" },
      };
    },
    resolveSecret: async (_ref, _options) => {
      stores.push(request.getStore());
      return "m5u-key";
    },
  });
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(() => new Response(METRICS_OK, { status: 200 }), calls);
  try {
    await plugin.definition.setup(ctx);
    await request.run("inv-1", () => handler("servers")!({ companyId: "company-1" }));
    await waitFor(() => calls.some((c) => c.url === "http://m5u.local/admin/api/activity"), 2000);
    assert.ok(stores.length >= 1, "expected the M5U token to be resolved");
    for (const store of stores) {
      assert.equal(store, undefined, "a poll started by a request-time load runs outside the request");
    }
  } finally {
    globalThis.fetch = realFetch;
    await plugin.definition.onShutdown?.();
  }
});
