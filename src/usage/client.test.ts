import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPlanUsage, httpErrorMessage, pickClaudeConnection } from "./client.ts";
import type { AiConnectionList, AiConnectionSummary } from "./types.ts";

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

const LIST_URL = "/api/companies/co-1/ai-connections";
const USAGE_URL = "/api/companies/co-1/ai-connections/conn-claude/usage?grantId=grant-claude";

// The server sends fields beyond the copied contract; the fixtures keep them.
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

const USAGE_OK = {
  connectionId: "conn-claude",
  grantId: "grant-claude",
  provider: "anthropic",
  method: "subscription",
  checkedAt: "2026-10-29T16:46:02.543Z",
  source: "anthropic_oauth",
  planType: null,
  limits: [
    {
      id: "five_hour",
      label: "5 hour limit",
      scope: null,
      windowDurationSeconds: 18000,
      resetsAt: "2026-10-29T21:00:00.000Z",
      usedPercent: 23,
    },
  ],
  overage: null,
  status: "ok",
};

/** A usage body carrying the connection fields Paperclip always sends. */
function usageBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    connectionId: "conn-claude",
    grantId: "grant-claude",
    provider: "anthropic",
    method: "subscription",
    checkedAt: "2026-10-29T16:46:02.543Z",
    limits: [],
    ...fields,
  };
}

test("returns the usage limits of the default Claude subscription", async () => {
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(200, LIST), [USAGE_URL]: json(200, USAGE_OK) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "ok",
    accountLabel: "owner@example.com",
    checkedAt: "2026-10-29T16:46:02.543Z",
    limits: USAGE_OK.limits,
  });
  assert.equal(calls[0]?.url, LIST_URL);
  assert.equal(calls[1]?.url, USAGE_URL);
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(calls[1]?.init?.credentials, "include");
});

test("pickClaudeConnection prefers the default subscription", () => {
  const first: AiConnectionSummary = {
    id: "conn-a",
    grantId: "grant-a",
    provider: "anthropic",
    method: "subscription",
    name: "Claude A",
    isDefault: false,
    status: "connected",
  };
  const second: AiConnectionSummary = { ...first, id: "conn-b", grantId: "grant-b", isDefault: true };
  assert.equal(pickClaudeConnection([first, second]), second);
});

test("pickClaudeConnection returns the first connected one when no default exists", () => {
  const broken: AiConnectionSummary = {
    id: "conn-a",
    grantId: "grant-a",
    provider: "anthropic",
    method: "subscription",
    name: "Claude A",
    isDefault: false,
    status: "needs_attention",
  };
  const openai: AiConnectionSummary = {
    id: "conn-openai",
    grantId: "grant-openai",
    provider: "openai",
    method: "api_key",
    name: "OpenAI",
    isDefault: true,
    status: "connected",
  };
  const apiKey: AiConnectionSummary = {
    id: "conn-key",
    grantId: "grant-key",
    provider: "anthropic",
    method: "api_key",
    name: "Anthropic key",
    isDefault: true,
    status: "connected",
  };
  const good: AiConnectionSummary = {
    id: "conn-good",
    grantId: "grant-good",
    provider: "anthropic",
    method: "subscription",
    name: "Claude Good",
    isDefault: false,
    status: "connected",
  };
  assert.equal(pickClaudeConnection([broken, openai, apiKey, good]), good);
});

test("fetchPlanUsage returns no_connection when only an openai connection exists", async () => {
  const openai = LIST.connections[0]!;
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(200, { connections: [openai] }) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, { kind: "no_connection" });
  assert.equal(calls.length, 1);
});

test("the default connection is reported on even when it needs attention", async () => {
  const brokenDefault: AiConnectionSummary = {
    id: "conn-claude",
    grantId: "grant-claude",
    provider: "anthropic",
    method: "subscription",
    name: "Claude Max",
    accountLabel: "owner@example.com",
    isDefault: true,
    status: "needs_attention",
    unavailableReason: "Reconnect with a separate sign-in to protect your existing terminal login.",
    usageProbeSupported: true,
  };
  const healthy: AiConnectionSummary = {
    ...brokenDefault,
    id: "conn-other",
    grantId: "grant-other",
    accountLabel: "other@example.com",
    isDefault: false,
    status: "connected",
    unavailableReason: undefined,
  };
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(200, { connections: [brokenDefault, healthy] }) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "needs_attention",
    accountLabel: "owner@example.com",
    message: "Reconnect with a separate sign-in to protect your existing terminal login.",
  });
  assert.equal(calls.length, 1);
});

test("a default Claude connection without usage support asks for attention after one call", async () => {
  const noProbe: AiConnectionSummary = {
    id: "conn-claude",
    grantId: "grant-claude",
    provider: "anthropic",
    method: "subscription",
    name: "Claude Max",
    accountLabel: "owner@example.com",
    isDefault: true,
    status: "connected",
    usageProbeSupported: false,
  };
  const { impl, calls } = fakeFetch({ [LIST_URL]: json(200, { connections: [noProbe] }) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "needs_attention",
    accountLabel: "owner@example.com",
    message: "This Claude sign-in does not report usage",
  });
  assert.equal(calls.length, 1);
});

test("a rate limited usage check becomes a rate-limited error", async () => {
  const { impl } = fakeFetch({
    [LIST_URL]: json(200, LIST),
    [USAGE_URL]: json(
      200,
      usageBody({
        status: "error",
        errorCode: "rate_limited",
        message: "The provider rate limited the usage check. Try again later.",
      }),
    ),
  });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "error",
    message: "The provider rate limited the usage check. Try again later.",
    rateLimited: true,
  });
});

test("an expired usage login becomes needs_attention", async () => {
  const { impl } = fakeFetch({
    [LIST_URL]: json(200, LIST),
    [USAGE_URL]: json(
      200,
      usageBody({
        status: "unavailable",
        errorCode: "authentication_required",
        message: "The provider could not authenticate this usage check. Reconnect the account.",
      }),
    ),
  });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "needs_attention",
    accountLabel: "owner@example.com",
    message: "The provider could not authenticate this usage check. Reconnect the account.",
  });
});

test("a provider outage becomes an error that is not rate limited", async () => {
  const { impl } = fakeFetch({
    [LIST_URL]: json(200, LIST),
    [USAGE_URL]: json(
      200,
      usageBody({
        status: "error",
        errorCode: "provider_unavailable",
        message: "Could not read provider usage. Try again later.",
      }),
    ),
  });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "error",
    message: "Could not read provider usage. Try again later.",
    rateLimited: false,
  });
});

test("a 403 on the connection list becomes a permission error", async () => {
  const { impl } = fakeFetch({ [LIST_URL]: json(403, { error: "Board access required" }) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, { kind: "error", message: "No permission to read AI connections", rateLimited: false });
});

test("a 429 on the usage check becomes a rate-limited error", async () => {
  const { impl } = fakeFetch({
    [LIST_URL]: json(200, LIST),
    [USAGE_URL]: json(429, { error: "Too many requests" }),
  });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, {
    kind: "error",
    message: "Paperclip is rate limiting requests, try again later",
    rateLimited: true,
  });
});

test("an empty connections body becomes an unexpected-response error", async () => {
  const { impl } = fakeFetch({ [LIST_URL]: json(200, {}) });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, { kind: "error", message: "Unexpected AI connections response", rateLimited: false });
});

test("a rejected fetch becomes a reachability error", async () => {
  const { impl } = fakeFetch({
    [LIST_URL]: () => {
      throw new TypeError("fetch failed");
    },
  });
  const result = await fetchPlanUsage("co-1", { fetchImpl: impl });
  assert.deepEqual(result, { kind: "error", message: "Could not reach Paperclip", rateLimited: false });
});

test("an aborted call rejects", async () => {
  const controller = new AbortController();
  controller.abort();
  const { impl } = fakeFetch({
    [LIST_URL]: () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  });
  await assert.rejects(fetchPlanUsage("co-1", { fetchImpl: impl, signal: controller.signal }));
});

test("the company id is encoded in the request url", async () => {
  const encodedUrl = "/api/companies/co%201%2Fx/ai-connections";
  const { impl, calls } = fakeFetch({ [encodedUrl]: json(200, { connections: [] }) });
  const result = await fetchPlanUsage("co 1/x", { fetchImpl: impl });
  assert.deepEqual(result, { kind: "no_connection" });
  assert.equal(calls[0]?.url, encodedUrl);
});

test("httpErrorMessage maps the statuses the panel distinguishes", () => {
  assert.equal(httpErrorMessage(401, "Claude usage"), "Sign in to Paperclip to see Claude usage");
  assert.equal(httpErrorMessage(403, "Claude usage"), "No permission to read AI connections");
  assert.equal(httpErrorMessage(404, "Claude usage"), "Claude usage not found");
  assert.equal(httpErrorMessage(429, "Claude usage"), "Paperclip is rate limiting requests, try again later");
  assert.equal(httpErrorMessage(500, "Claude usage"), "Claude usage request failed (HTTP 500)");
});
