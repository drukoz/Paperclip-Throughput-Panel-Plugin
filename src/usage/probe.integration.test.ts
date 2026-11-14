import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import plugin from "../worker.ts";
import manifest from "../manifest.ts";
import { runProbe } from "./probe-run.ts";
import { parseProbeOutput } from "./probe-parse.ts";
import { createProbeController } from "./probe-controller.ts";
import { probeAccountView } from "./probe-view.ts";
import type { PlanProbeSnapshot, ProbeAccountState } from "./probe-types.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "probe-integration-"));
const configDir = join(dir, "config");

/**
 * A shell wrapper that runs the fake CLI for one scenario. It runs the fake
 * under the test's own absolute node, because the child's PATH has no node in it.
 */
function wrapper(scenario: string): string {
  const path = join(dir, `claude-${scenario}`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${scenario} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const okWrapper = wrapper("ok");
const failWrapper = wrapper("fail");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The real runner and the real parser, choosing the wrapper by token: "tok-ok" works, every other token fails. */
function controllerFor(accounts: readonly { label: string; token: unknown }[]) {
  const controller = createProbeController({
    now: () => Date.now(),
    resolveToken: async (raw) => (typeof raw === "string" ? raw : null),
    run: (token) =>
      runProbe({
        claudePath: token === "tok-ok" ? okWrapper : failWrapper,
        token,
        configDir,
        timeoutMs: 10_000,
      }),
    parse: parseProbeOutput,
  });
  controller.configure(accounts, 15);
  return controller;
}

/** Minimal mock of the worker-side PluginContext: just config, secrets, logger and data. */
function makeCtx(config: Record<string, unknown>) {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => config },
    http: {
      // The worker must scrape with the global fetch, never the host's SSRF-guarded ctx.http.fetch.
      fetch: () => Promise.reject(new Error("ctx.http.fetch must not be used by the worker")),
    },
    secrets: { resolve: async () => "resolved-secret" },
    logger: { info() {}, warn() {}, error() {} },
    data: {
      register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        handlers.set(key, handler);
      },
    },
  } as unknown as PluginContext;
  return { ctx, handlers };
}

const WORKER_CONFIG = {
  metricsUrl: "http://probe.local/metrics",
  claudeAccount1Label: "A",
  claudeAccount1Token: "tok-1",
  claudePath: okWrapper,
};

/** The metrics endpoint answers 503: the throughput poll is not what these tests check. */
function stubMetricsFetch(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

type ProbeHandler = (params: Record<string, unknown>) => Promise<PlanProbeSnapshot>;

function planProbe(handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>): ProbeHandler {
  const probe = handlers.get("plan-probe");
  assert.ok(probe, 'the worker must register a "plan-probe" data handler');
  return probe as ProbeHandler;
}

/** Reads with `{}` every 25 ms, up to `timeoutMs`, until the account's first check has finished. */
async function waitForCheck(probe: ProbeHandler, timeoutMs: number): Promise<ProbeAccountState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await probe({});
    const account = snapshot.accounts[0];
    if (account && account.lastAttemptAt !== null && account.probing === false) return account;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for the check to finish`);
    await sleep(25);
  }
}

test("a working account ends as an ok view with the weekly meter", async () => {
  const controller = controllerFor([{ label: "A", token: "tok-ok" }]);
  await controller.kick();
  const state = controller.snapshot().accounts[0]!;
  const view = probeAccountView(state);
  assert.equal(view.kind, "ok");
  if (view.kind === "ok") {
    assert.equal(view.usage.weekly?.usedPercent, 96);
    assert.equal(view.usage.weekly?.source, "probe");
    assert.equal(view.usage.session, null);
    assert.equal(view.refreshError, null);
  }
});

test("a failing account ends as an error view with Claude Code's message", async () => {
  const controller = controllerFor([{ label: "B", token: "tok-fail" }]);
  await controller.kick();
  const state = controller.snapshot().accounts[0]!;
  assert.deepEqual(probeAccountView(state), {
    kind: "error",
    message: "Claude Code: Invalid API key · Fix external API key",
  });
});

test("the worker's plan-probe handler checks through the fake CLI", async () => {
  const restoreFetch = stubMetricsFetch();
  const { ctx, handlers } = makeCtx(WORKER_CONFIG);
  try {
    await plugin.definition.setup(ctx);
    const probe = planProbe(handlers);
    await probe({ active: true });
    const deadline = Date.now() + 5000;
    let account: ProbeAccountState | undefined;
    for (;;) {
      const snapshot = await probe({});
      account = snapshot.accounts[0];
      if (account && account.last !== null) break;
      if (Date.now() > deadline) throw new Error("timed out after 5000ms waiting for a reading");
      await sleep(25);
    }
    assert.equal(account!.last!.reading.usage.weekly!.usedPercent, 96);
    assert.equal(account!.error, null);
  } finally {
    restoreFetch();
    await plugin.definition.onShutdown?.();
  }
});

test("a second active read within the interval starts no second check", async () => {
  const restoreFetch = stubMetricsFetch();
  const { ctx, handlers } = makeCtx(WORKER_CONFIG);
  try {
    await plugin.definition.setup(ctx);
    const probe = planProbe(handlers);
    await probe({ active: true });
    const first = await waitForCheck(probe, 5000);
    await probe({ active: true });
    await sleep(300);
    const second = (await probe({})).accounts[0]!;
    assert.equal(second.lastAttemptAt, first.lastAttemptAt);
    assert.equal(second.probing, false);
  } finally {
    restoreFetch();
    await plugin.definition.onShutdown?.();
  }
});

test("the README documents every plugin setting", () => {
  const readme = readFileSync(README, "utf8");
  const schema = manifest.instanceConfigSchema as unknown as { properties: Record<string, unknown> };
  const keys = Object.keys(schema.properties);
  assert.ok(keys.length >= 12, `expected every plugin setting in the schema, got ${keys.length}`);
  // The README covers these two slots in the range rows below instead of by name.
  const rangeRows: Record<string, string> = {
    claudeAccount2Label: "`claudeAccount1Label` … `claudeAccount3Label`",
    claudeAccount2Token: "`claudeAccount1Token` … `claudeAccount3Token`",
  };
  for (const key of keys) {
    const row = rangeRows[key];
    if (row !== undefined) {
      assert.ok(readme.includes(row), `README is missing the range row "${row}"`);
      continue;
    }
    assert.ok(readme.includes(`\`${key}\``), `README does not mention \`${key}\` in backticks`);
  }
});
