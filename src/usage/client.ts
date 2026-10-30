import type { AiConnectionList, AiConnectionSummary, ConnectionUsage, PlanUsageResult } from "./types.ts";

/** Options for `fetchPlanUsage`. */
export interface FetchPlanUsageOptions {
  /** Defaults to `globalThis.fetch`; tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Aborts the requests; an aborted call rejects instead of returning a result. */
  signal?: AbortSignal;
}

/** Maps a Paperclip HTTP error status to a user-facing message about `what`. */
export function httpErrorMessage(status: number, what: string): string {
  switch (status) {
    case 401:
      return "Sign in to Paperclip to see Claude usage";
    case 403:
      return "No permission to read AI connections";
    case 404:
      return `${what} not found`;
    case 429:
      return "Paperclip is rate limiting requests, try again later";
    default:
      return `${what} request failed (HTTP ${status})`;
  }
}

/** Picks the Claude subscription the panel reports on: the default one, even when it is not connected. */
export function pickClaudeConnection(connections: readonly AiConnectionSummary[]): AiConnectionSummary | null {
  const claude = connections.filter((c) => c.provider === "anthropic" && c.method === "subscription");
  return claude.find((c) => c.isDefault) ?? claude.find((c) => c.status === "connected") ?? null;
}

/** Reads the default Claude subscription's usage from Paperclip's API; rejects only when the call is aborted. */
export async function fetchPlanUsage(
  companyId: string,
  options: FetchPlanUsageOptions = {},
): Promise<PlanUsageResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const init: RequestInit = {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: options.signal,
  };
  try {
    const listRes = await doFetch(`/api/companies/${encodeURIComponent(companyId)}/ai-connections`, init);
    if (!listRes.ok) {
      return {
        kind: "error",
        message: httpErrorMessage(listRes.status, "AI connections"),
        rateLimited: listRes.status === 429,
      };
    }
    const listBody = await readJson(listRes);
    if (typeof listBody !== "object" || listBody === null || !Array.isArray((listBody as AiConnectionList).connections)) {
      return { kind: "error", message: "Unexpected AI connections response", rateLimited: false };
    }
    const connection = pickClaudeConnection((listBody as AiConnectionList).connections);
    if (connection === null) {
      return { kind: "no_connection" };
    }
    const accountLabel = connection.accountLabel ?? connection.name;
    if (connection.status !== "connected") {
      return {
        kind: "needs_attention",
        accountLabel,
        message: connection.unavailableReason ?? "Reconnect Claude in AI connections",
      };
    }
    if (connection.usageProbeSupported === false) {
      return { kind: "needs_attention", accountLabel, message: "This Claude sign-in does not report usage" };
    }
    const usagePath =
      `/api/companies/${encodeURIComponent(companyId)}/ai-connections/${encodeURIComponent(connection.id)}/usage` +
      `?grantId=${encodeURIComponent(connection.grantId)}`;
    const usageRes = await doFetch(usagePath, init);
    if (!usageRes.ok) {
      return {
        kind: "error",
        message: httpErrorMessage(usageRes.status, "Claude usage"),
        rateLimited: usageRes.status === 429,
      };
    }
    const usageBody = await readJson(usageRes);
    if (
      typeof usageBody !== "object" ||
      usageBody === null ||
      typeof (usageBody as ConnectionUsage).status !== "string" ||
      !Array.isArray((usageBody as ConnectionUsage).limits)
    ) {
      return { kind: "error", message: "Unexpected usage response", rateLimited: false };
    }
    const usage = usageBody as ConnectionUsage;
    switch (usage.status) {
      case "ok":
        return { kind: "ok", accountLabel, checkedAt: usage.checkedAt, limits: usage.limits };
      case "unavailable":
        return { kind: "needs_attention", accountLabel, message: usage.message ?? "Reconnect Claude in AI connections" };
      case "unsupported":
        return {
          kind: "needs_attention",
          accountLabel,
          message: usage.message ?? "This Claude sign-in does not report usage",
        };
      default:
        return {
          kind: "error",
          message: usage.message ?? "Could not read Claude usage",
          rateLimited: usage.errorCode === "rate_limited",
        };
    }
  } catch (err) {
    if (options.signal?.aborted) {
      throw err;
    }
    return { kind: "error", message: "Could not reach Paperclip", rateLimited: false };
  }
}

/** Reads a JSON body, returning `undefined` when it is not valid JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
