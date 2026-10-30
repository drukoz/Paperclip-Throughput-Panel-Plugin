import type { PlanUsageReading, PlanUsageRow } from "./types.ts";

/** Turns one Claude Code window ({ utilization: 0-1, resetsAt: epoch seconds }) into a meter row; null when utilization is missing. */
export function windowRow(value: unknown): PlanUsageRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const utilization = (value as { utilization?: unknown }).utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null;
  }
  const rawResetsAt = (value as { resetsAt?: unknown }).resetsAt;
  const resetsAt =
    typeof rawResetsAt === "number" && Number.isFinite(rawResetsAt)
      ? new Date(rawResetsAt * 1000).toISOString()
      : null;
  return { usedPercent: Math.round(utilization * 10000) / 100, resetsAt };
}

/** Builds an "agent_run" reading observed at `at` from Claude Code's unifiedWindows; null when no window is usable. */
export function readingFromWindows(
  windows: Record<string, unknown>,
  at: string,
): PlanUsageReading | null {
  const session = windowRow(windows["five_hour"]);
  const weekly = windowRow(windows["seven_day"]);
  let fable: PlanUsageRow | null = null;
  for (const key of Object.keys(windows)) {
    if (/fable/i.test(key)) {
      fable = windowRow(windows[key]);
      break;
    }
  }
  if (session === null && weekly === null && fable === null) {
    return null;
  }
  return { source: "agent_run", at, usage: { session, weekly, fable } };
}

/** The last Claude Code rate_limit_event in a slice of a Paperclip run log, as a reading; null when there is none. */
export function latestRateLimitReading(content: string): PlanUsageReading | null {
  let result: PlanUsageReading | null = null;
  for (const line of content.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as { stream?: unknown; chunk?: unknown; ts?: unknown };
    if (record.stream !== "stdout") continue;
    if (typeof record.chunk !== "string" || typeof record.ts !== "string") continue;
    for (const piece of record.chunk.split("\n")) {
      if (!piece.includes('"rate_limit_event"')) continue;
      let event: unknown;
      try {
        event = JSON.parse(piece);
      } catch {
        continue;
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        continue;
      }
      const typed = event as { type?: unknown; rate_limit_info?: unknown };
      if (typed.type !== "rate_limit_event") continue;
      const info = typed.rate_limit_info;
      if (typeof info !== "object" || info === null || Array.isArray(info)) continue;
      const windows = (info as { unifiedWindows?: unknown }).unifiedWindows;
      if (typeof windows !== "object" || windows === null || Array.isArray(windows)) {
        continue;
      }
      const reading = readingFromWindows(windows as Record<string, unknown>, record.ts);
      if (reading !== null) result = reading;
    }
  }
  return result;
}
