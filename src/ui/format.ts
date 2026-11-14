import type { PlanUsage, PlanUsageRow, PlanUsageSource } from "../usage/types.ts";

/** Placeholder for every missing value (em dash, U+2014). */
const DASH = "—";

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 0 -> "0", 12.4 -> "12", 1234 -> "1.2k". Null/undefined/non-finite -> "—". */
export function formatRate(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return DASH;
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

/** 42.37 -> "42%". Null/undefined/non-finite -> "—". */
export function formatPct(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return DASH;
  return `${Math.round(value)}%`;
}

/** 0 -> "0". Null/undefined/non-finite -> "—". */
export function formatCount(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return DASH;
  return String(Math.round(value));
}

/**
 * ISO string -> "3s ago" / "2m ago" / "1h ago", relative to `now`
 * (default Date.now()). Null / unparseable -> "never".
 */
export function formatAge(iso: string | null, now?: number): string {
  if (iso === null) return "never";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "never";
  const ref = now ?? Date.now();
  const seconds = Math.max(0, Math.round((ref - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * ISO reset time -> "resets now" / "resets in 42m" / "resets in 3h 14m" /
 * "resets in 2d 4h", relative to `now` (default Date.now()).
 * Null / unparseable -> "reset time not reported".
 */
export function formatResetIn(iso: string | null, now?: number): string {
  if (iso === null) return "reset time not reported";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "reset time not reported";
  const ref = now ?? Date.now();
  const minutes = Math.ceil((parsed - ref) / 60_000);
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `resets in ${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `resets in ${days}d ${restHours}h`;
}

/**
 * ISO time -> "Thu 5 Nov 16:00": short weekday, day, short month and 24-hour
 * time in `timeZone` (default: the viewer's own zone). Null / unparseable -> "—".
 */
export function formatResetAt(iso: string | null, timeZone?: string): string {
  if (iso === null) return DASH;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return DASH;
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(parsed));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}

/** Meter colour for a percent used: >= 90 red, >= 75 amber, else green. */
export function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "#ef4444";
  if (usedPercent >= 75) return "#f59e0b";
  return "#22c55e";
}

/** "agent_run" -> "from an agent run", "usage_check" -> "from Anthropic's usage check", "probe" -> "from a Claude Code check", undefined -> "". */
export function formatSource(source: PlanUsageSource | undefined): string {
  if (source === "agent_run") return "from an agent run";
  if (source === "usage_check") return "from Anthropic's usage check";
  if (source === "probe") return "from a Claude Code check";
  return "";
}

/** True when `resetsAt` parses and is at or before `now` (epoch ms): the window restarted after the reading. */
export function isWindowRestarted(resetsAt: string | null, now: number): boolean {
  if (resetsAt === null) return false;
  const parsed = Date.parse(resetsAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= now;
}

/** The tooltip and screen-reader sentence for one meter at `now` (epoch ms). */
export function meterDetails(label: string, row: PlanUsageRow | null, now: number): string {
  if (row === null) return `${label}: no reading yet`;
  if (isWindowRestarted(row.resetsAt, now)) {
    return `${label}: window restarted ${formatAge(row.resetsAt, now)}; no reading since`;
  }
  const base = `${label}: ${formatPct(row.usedPercent)} used, ${formatResetIn(row.resetsAt, now)}`;
  if (row.at !== undefined) {
    return `${base}, as of ${formatAge(row.at, now)} ${formatSource(row.source)}`;
  }
  return base;
}

/**
 * The reset time the "Resets" row shows: the weekly window's, or the Fable
 * window's when weekly is missing. Null when that time is missing,
 * unparseable or already past at `now` (epoch ms).
 */
export function nextResetAt(usage: PlanUsage, now: number): string | null {
  const row = usage.weekly ?? usage.fable;
  if (row === null) return null;
  if (row.resetsAt === null) return null;
  if (!Number.isFinite(Date.parse(row.resetsAt))) return null;
  if (isWindowRestarted(row.resetsAt, now)) return null;
  return row.resetsAt;
}

/** The tooltip and screen-reader sentence for the "Resets" row. */
export function resetDetails(resetsAt: string | null, now: number, timeZone?: string): string {
  if (resetsAt === null) return "Weekly limit: next reset time not known yet";
  return `Weekly limit ${formatResetIn(resetsAt, now)}, on ${formatResetAt(resetsAt, timeZone)}`;
}
