import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPlanUsage } from "./client.ts";
import { nextPlanUsageDelayMs, reducePlanUsageView } from "./view.ts";
import type { AiConnectionList, AiConnectionSummary } from "./types.ts";

// Integration test for RUK-249: it drives Paperclip-shaped responses through the
// client, the meter selection (via reducePlanUsageView) and the view reducer together.

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

function json(body: unknown): Route {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const LIST_URL = "/api/companies/co-1/ai-connections";
const USAGE_URL = "/api/companies/co-1/ai-connections/conn-claude/usage?grantId=grant-claude";

// Complete body of GET /api/companies/co-1/ai-connections, from Paperclip 2026.1023.0.
// Server sends more than the copied contract; the fixture type adds those fields.
type FixtureConnection = AiConnectionSummary & { companyId: string; ownership: string };
type FixtureList = AiConnectionList & Record<string, unknown> & { connections: FixtureConnection[] };

const LIST: FixtureList = {
  currentUserId: "user-1",
  pools: [],
  canManageConnections: true,
  connections: [
    {
      id: "conn-local",
      grantId: "grant-local",
      companyId: "co-1",
      provider: "openai",
      method: "api_key",
      name: "Company Local endpoint",
      ownership: "shared",
      isDefault: true,
      status: "connected",
      usageProbeSupported: false,
    },
    {
      id: "conn-claude",
      grantId: "grant-claude",
      companyId: "co-1",
      provider: "anthropic",
      method: "subscription",
      name: "Claude Max",
      accountLabel: "owner@example.com",
      ownership: "personal",
      isDefault: true,
      status: "connected",
      usageProbeSupported: true,
    },
  ],
};

// Complete usage body for an account with a Fable weekly window, produced by
// running Paperclip's own parser (scope group ids are percent-encoded).
const USAGE_FULL = {
  connectionId: "conn-claude",
  grantId: "grant-claude",
  provider: "anthropic",
  method: "subscription",
  checkedAt: "2026-10-29T16:46:02.543Z",
  source: "anthropic_oauth",
  planType: null,
  status: "ok",
  limits: [
    { scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "five_hour", label: "5 hour limit", usedPercent: 23, remainingPercent: 77, limitReached: false },
    { scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "seven_day", label: "Weekly limit", usedPercent: 41, remainingPercent: 59, limitReached: false },
    { scope: "seven_day_sonnet", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "seven_day_sonnet", label: "Sonnet weekly limit", usedPercent: 5, remainingPercent: 95, limitReached: false },
    { scope: "seven_day_overage_included", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "seven_day_overage_included", label: "seven day overage included", usedPercent: 12, remainingPercent: 88, limitReached: false },
    { scope: "group:session", windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "five_hour.scope.group%3Asession", label: "5 hour limit · session", usedPercent: 23, remainingPercent: 77, limitReached: false },
    { scope: "group:weekly", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "seven_day.scope.group%3Aweekly", label: "Weekly limit · weekly", usedPercent: 41, remainingPercent: 59, limitReached: false },
    { scope: "group:weekly · model:Fable", windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "weekly_scoped.2.scope.group%3Aweekly%7Cmodel%3AFable", label: "weekly scoped · weekly · Fable", usedPercent: 12, remainingPercent: 88, limitReached: false },
    { scope: "overage", windowDurationSeconds: null, resetsAt: null, used: null, limit: null, remaining: null, unit: "cents", allowed: false, id: "extra_usage", label: "Monthly extra usage", usedPercent: null, remainingPercent: null, limitReached: null },
  ],
  overage: { enabled: false, available: false, unlimited: null, used: null, limit: null, remaining: null, balance: null, unit: "cents" },
};

// Same body as USAGE_FULL, with the limits an account without per-model rows returns.
const USAGE_LEGACY = {
  ...USAGE_FULL,
  limits: [
    { scope: null, windowDurationSeconds: 18000, resetsAt: "2026-10-29T21:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "five_hour", label: "5 hour limit", usedPercent: 64, remainingPercent: 36, limitReached: false },
    { scope: null, windowDurationSeconds: 604800, resetsAt: "2026-11-03T16:00:00.000Z", used: null, limit: null, remaining: null, unit: "percent", allowed: null, id: "seven_day", label: "Weekly limit", usedPercent: 88, remainingPercent: 12, limitReached: false },
  ],
};

// 200 body when Anthropic rate-limits the usage check.
const USAGE_RATE_LIMITED = {
  connectionId: "conn-claude",
  grantId: "grant-claude",
  provider: "anthropic",
  method: "subscription",
  checkedAt: "2026-10-29T16:51:02.543Z",
  source: null,
  planType: null,
  limits: [],
  overage: null,
  status: "error",
  errorCode: "rate_limited",
  message: "The provider rate limited the usage check. Try again later.",
};

test("full account: client, selection and reducer produce the three meters", async () => {
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(LIST), [USAGE_URL]: json(USAGE_FULL) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  const view = reducePlanUsageView({ kind: "loading" }, result);
  assert.deepEqual(view, {
    kind: "ok",
    usage: {
      session: { usedPercent: 23, resetsAt: "2026-10-29T21:00:00.000Z" },
      weekly: { usedPercent: 41, resetsAt: "2026-11-03T16:00:00.000Z" },
      fable: { usedPercent: 12, resetsAt: "2026-11-03T16:00:00.000Z" },
    },
    accountLabel: "owner@example.com",
    checkedAt: "2026-10-29T16:46:02.543Z",
    refreshError: null,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, LIST_URL);
  assert.equal(calls[1]?.url, USAGE_URL);
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(calls[1]?.init?.credentials, "include");
});

test("legacy account: session and weekly meters, no Fable row", async () => {
  const { impl } = fakeFetch({ [LIST_URL]: json(LIST), [USAGE_URL]: json(USAGE_LEGACY) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  const view = reducePlanUsageView({ kind: "loading" }, result);
  assert.deepEqual(view, {
    kind: "ok",
    usage: {
      session: { usedPercent: 64, resetsAt: "2026-10-29T21:00:00.000Z" },
      weekly: { usedPercent: 88, resetsAt: "2026-11-03T16:00:00.000Z" },
      fable: null,
    },
    accountLabel: "owner@example.com",
    checkedAt: "2026-10-29T16:46:02.543Z",
    refreshError: null,
  });
});

test("rate limit after a good check keeps the meters and marks the retry delay", async () => {
  const good = fakeFetch({ [LIST_URL]: json(LIST), [USAGE_URL]: json(USAGE_FULL) });
  const first = await fetchPlanUsage("co-1", { fetchImpl: good.impl });
  const okView = reducePlanUsageView({ kind: "loading" }, first);

  const limited = fakeFetch({ [LIST_URL]: json(LIST), [USAGE_URL]: json(USAGE_RATE_LIMITED) });
  const second = await fetchPlanUsage("co-1", { fetchImpl: limited.impl });
  const view = reducePlanUsageView(okView, second);

  assert.deepEqual(view, {
    kind: "ok",
    usage: {
      session: { usedPercent: 23, resetsAt: "2026-10-29T21:00:00.000Z" },
      weekly: { usedPercent: 41, resetsAt: "2026-11-03T16:00:00.000Z" },
      fable: { usedPercent: 12, resetsAt: "2026-11-03T16:00:00.000Z" },
    },
    accountLabel: "owner@example.com",
    checkedAt: "2026-10-29T16:46:02.543Z",
    refreshError: "Rate limited by Anthropic, retrying in 15 min",
  });
  assert.equal(nextPlanUsageDelayMs(second), 900_000);
});

test("default needs attention: one call, the reconnect message is shown", async () => {
  const list = structuredClone(LIST);
  const claude = list.connections[1]!;
  claude.status = "needs_attention";
  claude.unavailableReason =
    "Reconnect with a separate sign-in to protect your existing terminal login.";
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(list) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  const view = reducePlanUsageView({ kind: "loading" }, result);
  assert.deepEqual(view, {
    kind: "needs_attention",
    accountLabel: "owner@example.com",
    message: "Reconnect with a separate sign-in to protect your existing terminal login.",
  });
  assert.equal(calls.length, 1);
});

test("no Claude subscription: the section reports no connection", async () => {
  const list = structuredClone(LIST);
  list.connections = [list.connections[0]!];
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(list) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  const view = reducePlanUsageView({ kind: "loading" }, result);
  assert.deepEqual(view, { kind: "no_connection" });
  assert.equal(calls.length, 1);
});
