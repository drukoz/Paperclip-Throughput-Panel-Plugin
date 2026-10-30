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

/** Meter colour for a percent used: >= 90 red, >= 75 amber, else green. */
export function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "#ef4444";
  if (usedPercent >= 75) return "#f59e0b";
  return "#22c55e";
}
