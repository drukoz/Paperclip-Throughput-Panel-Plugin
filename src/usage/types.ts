/**
 * Claude plan usage contract (RUK-249).
 *
 * The first four interfaces are subsets of Paperclip's own API responses,
 * copied from @paperclipai/shared 2026.1023.0 (`ai-connections.d.ts` and
 * `ai-connection-usage.d.ts`; unchanged in 2026.1029.0-nightly.0). Only the
 * fields this plugin reads are declared; the server sends more.
 */

/** One entry of `connections[]` from `GET /api/companies/:companyId/ai-connections`. */
export interface AiConnectionSummary {
  id: string;
  grantId: string;
  /** "anthropic", "openai", "openrouter", "xai", "google" or "github". */
  provider: string;
  /** "subscription" or "api_key". */
  method: string;
  name: string;
  accountLabel?: string;
  /** True for the signed-in user's default connection for this provider. */
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
  usageProbeSupported?: boolean;
}

/** Body of `GET /api/companies/:companyId/ai-connections`. */
export interface AiConnectionList {
  connections: AiConnectionSummary[];
}

/** One entry of `limits[]` in the usage response. */
export interface UsageLimit {
  id: string;
  label: string;
  /**
   * null for an account-wide window. Otherwise a legacy bucket name such as
   * "seven_day_sonnet", or " · "-joined parts such as "group:weekly" or
   * "group:weekly · model:Fable".
   */
  scope: string | null;
  /** 18000 for the 5-hour session window, 604800 for weekly windows, else null. */
  windowDurationSeconds: number | null;
  /** ISO 8601 reset time, or null. */
  resetsAt: string | null;
  /** Percent of the window used, 0-100 (can exceed 100); null when not reported. */
  usedPercent: number | null;
}

/** Body of `GET /api/companies/:companyId/ai-connections/:connectionId/usage?grantId=...`. */
export interface ConnectionUsage {
  status: "ok" | "unsupported" | "unavailable" | "error";
  /** ISO 8601 time at which Paperclip asked Anthropic. */
  checkedAt: string;
  limits: UsageLimit[];
  errorCode?:
    | "unsupported"
    | "connection_unavailable"
    | "authentication_required"
    | "permission_denied"
    | "rate_limited"
    | "provider_unavailable"
    | "invalid_response";
  message?: string;
}

/** One meter in the panel. */
export interface PlanUsageRow {
  /** Percent of the window used, 0-100 (can exceed 100). */
  usedPercent: number;
  /** ISO 8601 reset time, or null when Anthropic gave none. */
  resetsAt: string | null;
  /** Set on merged meters: which source the row came from. */
  source?: PlanUsageSource;
  /** Set on merged meters: ISO 8601 time the row was observed. */
  at?: string;
}

/** The three meters the panel shows. A meter is null when Anthropic did not report it. */
export interface PlanUsage {
  /** The rolling 5-hour session window. */
  session: PlanUsageRow | null;
  /** The 7-day window across all models. */
  weekly: PlanUsageRow | null;
  /** The 7-day window for Fable only. */
  fable: PlanUsageRow | null;
}

/** The outcome of one `fetchPlanUsage` call. */
export type PlanUsageResult =
  | { kind: "ok"; accountLabel: string; checkedAt: string; limits: UsageLimit[] }
  | { kind: "no_connection" }
  | { kind: "needs_attention"; accountLabel: string; message: string }
  | { kind: "error"; message: string; rateLimited: boolean };

/** What the panel's "Claude plan" section renders. */
export type PlanUsageView =
  | { kind: "loading" }
  | {
      kind: "ok";
      usage: PlanUsage;
      accountLabel: string;
      checkedAt: string;
      /** Set when the latest check failed and these meters are from an earlier one. */
      refreshError: string | null;
    }
  | { kind: "no_connection" }
  | { kind: "needs_attention"; accountLabel: string; message: string }
  | { kind: "error"; message: string };

/** Where a meter's numbers came from: an agent run's log or Anthropic's usage check. */
export type PlanUsageSource = "agent_run" | "usage_check";

/** The three meters as one source reported them at one moment. */
export interface PlanUsageReading {
  source: PlanUsageSource;
  /** ISO 8601 time the numbers were observed. */
  at: string;
  usage: PlanUsage;
}

/**
 * The usage-check state the panel keeps in localStorage per company, so page
 * reloads and other tabs reuse the last check instead of asking Anthropic again.
 */
export interface StoredPlanUsage {
  /** Epoch ms of the last usage check attempt. */
  lastAttemptAt: number;
  /** Epoch ms before which no automatic usage check runs. */
  nextCheckAt: number;
  /** The last successful usage check, or null when none has succeeded. */
  good: PlanUsageReading | null;
  /** Account label from the last result that named one, or null. */
  accountLabel: string | null;
  /** The last attempt's result, or null before the first attempt. */
  last: PlanUsageResult | null;
}
