import { readingFromWindows } from "./run-events.ts";
import type { ProbeParseResult } from "./probe-types.ts";

/** Longest piece of Claude Code's error text kept in a message. */
export const PROBE_ERROR_TEXT_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The event's unifiedWindows, or its top-level limiting window when it has none; {} when neither is usable. */
function windowsOf(info: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(info.unifiedWindows)) return info.unifiedWindows;
  if (typeof info.rateLimitType === "string" && typeof info.utilization === "number") {
    return { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } };
  }
  return {};
}

/**
 * Reads the stream-json output of one Claude check: the last rate_limit_event
 * as the account's usage observed at `at`, or the reason there is none.
 * Never throws.
 */
export function parseProbeOutput(stdout: string, at: string): ProbeParseResult {
  let info: Record<string, unknown> | null = null;
  let resultSeen = false;
  let resultError: string | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    if (value.type === "rate_limit_event" && isRecord(value.rate_limit_info)) {
      info = value.rate_limit_info;
    } else if (value.type === "result") {
      resultSeen = true;
      if (value.is_error === true) {
        const text = typeof value.result === "string" ? value.result.trim() : "";
        resultError = text === "" ? "unknown error" : text.slice(0, PROBE_ERROR_TEXT_MAX);
      }
    }
  }
  if (info !== null) {
    const reading = readingFromWindows(windowsOf(info), at, "probe");
    if (reading === null) return { kind: "error", message: "Claude Code reported no usage figures" };
    return {
      kind: "ok",
      observation: {
        reading,
        status: stringOrNull(info.status),
        rateLimitType: stringOrNull(info.rateLimitType),
        overageStatus: stringOrNull(info.overageStatus),
        overageDisabledReason: stringOrNull(info.overageDisabledReason),
      },
    };
  }
  if (resultError !== null) return { kind: "error", message: `Claude Code: ${resultError}` };
  if (resultSeen) return { kind: "error", message: "Claude Code answered without a usage report" };
  return { kind: "error", message: "Claude Code printed no usage report" };
}
