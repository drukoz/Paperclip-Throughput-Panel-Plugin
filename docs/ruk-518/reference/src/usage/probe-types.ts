/**
 * Contract of the per-account Claude check (RUK-518). The worker runs a tiny
 * Claude Code request for each Claude account set in the plugin settings and
 * reads the rate_limit_event Claude Code prints; the panel shows the result.
 */
import type { PlanUsageReading } from "./types.ts";

/** What one Claude check of one account reported. */
export interface ProbeObservation {
  /** The meters Claude Code reported, as a reading with source "probe"; a meter it did not report is null. */
  reading: PlanUsageReading;
  /** Claude Code's status for the account: "allowed", "allowed_warning" or "rejected"; null when missing. */
  status: string | null;
  /** The window Claude Code named as the limiting one, for example "seven_day"; null when missing. */
  rateLimitType: string | null;
  /** Extra-usage status, for example "rejected"; null when missing. */
  overageStatus: string | null;
  /** Why extra usage is off, for example "out_of_credits"; null when missing. */
  overageDisabledReason: string | null;
}

/** The outcome of reading one check's output. */
export type ProbeParseResult =
  | { kind: "ok"; observation: ProbeObservation }
  | { kind: "error"; message: string };

/** What running the Claude Code CLI once produced. */
export interface ProbeRunResult {
  /** Standard output, cut at the byte cap. */
  stdout: string;
  /** Standard error, cut at the byte cap. */
  stderr: string;
  /** The exit code, or null when the process was killed or never started. */
  exitCode: number | null;
  /** True when the process was killed for running past the timeout. */
  timedOut: boolean;
  /** Why the process could not be started, for example "spawn /x/claude ENOENT"; null otherwise. */
  spawnError: string | null;
}

/** One account's state, as the worker serves it to the panel. */
export interface ProbeAccountState {
  /** The account's label from the plugin settings. */
  label: string;
  /** The last successful observation; kept when later checks fail. */
  last: ProbeObservation | null;
  /** ISO 8601 time of the last check attempt, or null before the first. */
  lastAttemptAt: string | null;
  /** The last attempt's error, or null when it succeeded or none has run. */
  error: string | null;
  /** True while a check of this account is running. */
  probing: boolean;
}

/** Body of the worker's "plan-probe" data handler. */
export interface PlanProbeSnapshot {
  /** One entry per configured account, in settings order; empty when none is configured. */
  accounts: ProbeAccountState[];
  /** Minutes between automatic checks of one account. */
  intervalMinutes: number;
}
