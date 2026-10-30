import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRunPlanUsage } from "./run-client.ts";
import type { RunLogMemo } from "./run-client.ts";

type Route = () => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
  return { impl, calls };
}

function json(status: number, body: unknown): Route {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const AGENTS_URL = "/api/companies/co-1/agents";
const runsUrl = (agentId: string) =>
  `/api/companies/co-1/heartbeat-runs?agentId=${agentId}&limit=3&summary=true`;
const logUrl = (runId: string, offset: number) =>
  `/api/heartbeat-runs/${runId}/log?offset=${offset}&limitBytes=524288`;

function eventLine(ts: string, fiveHour: number, sevenDay: number): string {
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1793334000, status: "allowed" },
        seven_day: { utilization: sevenDay, resetsAt: 1793894400, status: "allowed" },
      },
    },
  };
  return JSON.stringify({ ts, stream: "stdout", chunk: JSON.stringify(event) + "\n", seq: 1 }) + "\n";
}

const plainLine = JSON.stringify({ ts: "2026-10-30T02:00:00.000Z", stream: "stdout", chunk: '{"type":"system"}\n', seq: 1 }) + "\n";

const logBody = (runId: string, content: string) => ({ runId, store: "local_file", logRef: "x", content });

const claudeAgent = { id: "a-claude", adapterType: "claude_local", name: "CTO" };
const localAgent = { id: "a-local", adapterType: "opencode_local", name: "Engineer 1" };

test("reads the reading from the newest Claude run's log tail", async () => {
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent, localAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(200, logBody("run-new", eventLine("2026-10-30T02:10:00.000Z", 0.13, 0.04))),
  });
  const reading = await fetchRunPlanUsage("co-1", { fetchImpl: impl });
  assert.ok(reading !== null);
  assert.equal(reading.source, "agent_run");
  assert.equal(reading.at, "2026-10-30T02:10:00.000Z");
  assert.equal(reading.usage.session?.usedPercent, 13);
  assert.equal(reading.usage.weekly?.usedPercent, 4);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.url, logUrl("run-new", 0));
  for (const call of calls) {
    assert.equal(call.init?.credentials, "include");
  }
  assert.ok(!calls.some((call) => call.url === runsUrl("a-local")));
});

test("returns null when no agent is a Claude agent", async () => {
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [localAgent]),
  });
  assert.equal(await fetchRunPlanUsage("co-1", { fetchImpl: impl }), null);
  assert.equal(calls.length, 1);
});

test("falls back to the older run when the newest log has no event", async () => {
  const { impl } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
      { id: "run-old", status: "succeeded", createdAt: "2026-10-30T01:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(200, logBody("run-new", plainLine)),
    [logUrl("run-old", 0)]: json(200, logBody("run-old", eventLine("2026-10-30T01:10:00.000Z", 0.55, 0.22))),
  });
  const reading = await fetchRunPlanUsage("co-1", { fetchImpl: impl });
  assert.ok(reading !== null);
  assert.equal(reading.at, "2026-10-30T01:10:00.000Z");
  assert.equal(reading.usage.session?.usedPercent, 55);
});

test("an unchanged size is served from the memo without a log request", async () => {
  const routes = {
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(200, logBody("run-new", eventLine("2026-10-30T02:10:00.000Z", 0.13, 0.04))),
  };
  const first = fakeFetch(routes);
  const memo: RunLogMemo = new Map();
  const reading1 = await fetchRunPlanUsage("co-1", { fetchImpl: first.impl, memo });
  const second = fakeFetch(routes);
  const reading2 = await fetchRunPlanUsage("co-1", { fetchImpl: second.impl, memo });
  assert.equal(second.calls.length, 2);
  assert.ok(!second.calls.some((call) => call.url.startsWith("/api/heartbeat-runs/")));
  assert.deepEqual(reading2, reading1);
});

test("a grown log is read from the memo size, and a newer event wins", async () => {
  const routes = {
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(200, logBody("run-new", eventLine("2026-10-30T02:10:00.000Z", 0.13, 0.04))),
  };
  const memo: RunLogMemo = new Map();
  const first = fakeFetch(routes);
  const reading1 = await fetchRunPlanUsage("co-1", { fetchImpl: first.impl, memo });
  assert.ok(reading1 !== null);
  assert.equal(reading1.usage.session?.usedPercent, 13);
  const grown = fakeFetch({
    ...routes,
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "running", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: 1500 },
    ]),
    [logUrl("run-new", 1000)]: json(200, logBody("run-new", eventLine("2026-10-30T02:20:00.000Z", 0.2, 0.07))),
  });
  const reading2 = await fetchRunPlanUsage("co-1", { fetchImpl: grown.impl, memo });
  assert.ok(reading2 !== null);
  assert.equal(reading2.usage.session?.usedPercent, 20);
  assert.ok(grown.calls.some((call) => call.url === logUrl("run-new", 1000)));
});

test("a grown log with no new event keeps the cached reading", async () => {
  const routes = {
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(200, logBody("run-new", eventLine("2026-10-30T02:10:00.000Z", 0.13, 0.04))),
  };
  const memo: RunLogMemo = new Map();
  const first = fakeFetch(routes);
  await fetchRunPlanUsage("co-1", { fetchImpl: first.impl, memo });
  const grown = fakeFetch({
    ...routes,
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "running", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: 1500 },
    ]),
    [logUrl("run-new", 1000)]: json(200, logBody("run-new", plainLine)),
  });
  const reading = await fetchRunPlanUsage("co-1", { fetchImpl: grown.impl, memo });
  assert.ok(reading !== null);
  assert.equal(reading.usage.session?.usedPercent, 13);
});

test("a running run reads from 256 KiB before lastOutputBytes", async () => {
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-live", status: "running", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: 300000 },
    ]),
    [logUrl("run-live", 37856)]: json(200, logBody("run-live", plainLine)),
  });
  assert.equal(await fetchRunPlanUsage("co-1", { fetchImpl: impl }), null);
  assert.ok(calls.some((call) => call.url === logUrl("run-live", 37856)));
});

test("a run with no sizes is skipped without a log request", async () => {
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-empty", status: "running", createdAt: "2026-10-30T02:00:00.000Z", logBytes: null, lastOutputBytes: null },
    ]),
  });
  assert.equal(await fetchRunPlanUsage("co-1", { fetchImpl: impl }), null);
  assert.equal(calls.length, 2);
});

test("a 403 agents list returns null; a 500 log skips the run and stays out of the memo", async () => {
  const forbidden = fakeFetch({ [AGENTS_URL]: json(403, { error: "forbidden" }) });
  assert.equal(await fetchRunPlanUsage("co-1", { fetchImpl: forbidden.impl }), null);

  const memo: RunLogMemo = new Map();
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-new", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
      { id: "run-old", status: "succeeded", createdAt: "2026-10-30T01:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-new", 0)]: json(500, { error: "server error" }),
    [logUrl("run-old", 0)]: json(200, logBody("run-old", eventLine("2026-10-30T01:10:00.000Z", 0.55, 0.22))),
  });
  const reading = await fetchRunPlanUsage("co-1", { fetchImpl: impl, memo });
  assert.ok(reading !== null);
  assert.equal(reading.usage.session?.usedPercent, 55);
  assert.ok(calls.some((call) => call.url === logUrl("run-old", 0)));
  assert.equal(memo.has("run-new"), false);
  assert.equal(memo.has("run-old"), true);
});

test("an aborted call rejects", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await assert.rejects(fetchRunPlanUsage("co-1", { fetchImpl, signal: controller.signal }));
});

test("runs from two Claude agents are searched newest first", async () => {
  const { impl, calls } = fakeFetch({
    [AGENTS_URL]: json(200, [claudeAgent, { id: "a-claude-2", adapterType: "claude_local", name: "CTO 2" }]),
    [runsUrl("a-claude")]: json(200, [
      { id: "run-early", status: "succeeded", createdAt: "2026-10-30T02:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [runsUrl("a-claude-2")]: json(200, [
      { id: "run-late", status: "succeeded", createdAt: "2026-10-30T03:00:00.000Z", logBytes: 1000, lastOutputBytes: 1000 },
    ]),
    [logUrl("run-late", 0)]: json(200, logBody("run-late", eventLine("2026-10-30T03:10:00.000Z", 0.3, 0.11))),
    [logUrl("run-early", 0)]: json(200, logBody("run-early", eventLine("2026-10-30T02:10:00.000Z", 0.13, 0.04))),
  });
  const reading = await fetchRunPlanUsage("co-1", { fetchImpl: impl });
  assert.ok(reading !== null);
  assert.equal(reading.usage.session?.usedPercent, 30);
  assert.ok(calls.some((call) => call.url === logUrl("run-late", 0)));
  assert.ok(!calls.some((call) => call.url === logUrl("run-early", 0)));
});
