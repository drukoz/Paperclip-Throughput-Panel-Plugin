import { latestRateLimitReading } from "./run-events.ts";
import type { PlanUsageReading } from "./types.ts";

/** What the reader remembers about one run between calls. */
export interface RunLogMemoEntry {
  /** The log size in bytes when it was last read. */
  size: number;
  /** The newest reading found in that run so far, or null. */
  reading: PlanUsageReading | null;
}

/** Keyed by run id. The caller keeps one Map for as long as the panel is open. */
export type RunLogMemo = Map<string, RunLogMemoEntry>;

/** Options for `fetchRunPlanUsage`. */
export interface FetchRunPlanUsageOptions {
  /** Defaults to `globalThis.fetch`; tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** Aborts the requests; an aborted call rejects instead of returning. */
  signal?: AbortSignal;
  /** Reads remembered from earlier calls; a fresh Map when omitted. */
  memo?: RunLogMemo;
}

/** Bytes read from the end of a run log. */
export const RUN_LOG_TAIL_BYTES = 262_144;
/** Bytes requested per log read: the tail plus room for output Paperclip has written but not yet counted in lastOutputBytes. */
export const RUN_LOG_READ_BYTES = 524_288;
/** How many of the newest Claude runs are searched, newest first. */
export const RUN_LOOKBACK = 3;

/** A run row kept from the heartbeat-runs response, with the fields the reader uses. */
interface RunRow {
  id: string;
  createdAt: unknown;
  logBytes: unknown;
  lastOutputBytes: unknown;
}

/**
 * The newest plan usage Claude Code wrote into a recent Claude agent run's log,
 * or null when none is found or Paperclip cannot be read. Rejects only when aborted.
 */
export async function fetchRunPlanUsage(
  companyId: string,
  options: FetchRunPlanUsageOptions = {},
): Promise<PlanUsageReading | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const init: RequestInit = {
    credentials: "include",
    headers: { accept: "application/json" },
    signal: options.signal,
  };
  const memo = options.memo ?? new Map<string, RunLogMemoEntry>();
  try {
    const agentsRes = await doFetch(`/api/companies/${encodeURIComponent(companyId)}/agents`, init);
    if (!agentsRes.ok) {
      return null;
    }
    const agentsBody = await readJson(agentsRes);
    if (!Array.isArray(agentsBody)) {
      return null;
    }
    const claudeAgentIds = agentsBody
      .filter((row) => isRecord(row) && row.adapterType === "claude_local" && typeof row.id === "string")
      .map((row) => (row as { id: string }).id);
    if (claudeAgentIds.length === 0) {
      return null;
    }
    const runs: RunRow[] = [];
    for (const agentId of claudeAgentIds) {
      const runsRes = await doFetch(
        `/api/companies/${encodeURIComponent(companyId)}/heartbeat-runs` +
          `?agentId=${encodeURIComponent(agentId)}&limit=3&summary=true`,
        init,
      );
      if (!runsRes.ok) {
        continue;
      }
      const runsBody = await readJson(runsRes);
      if (!Array.isArray(runsBody)) {
        continue;
      }
      for (const row of runsBody) {
        if (isRecord(row) && typeof row.id === "string") {
          runs.push({ id: row.id, createdAt: row.createdAt, logBytes: row.logBytes, lastOutputBytes: row.lastOutputBytes });
        }
      }
    }
    runs.sort((a, b) => runTime(b) - runTime(a) || 0);
    for (const run of runs.slice(0, RUN_LOOKBACK)) {
      const size = runSize(run);
      if (size <= 0) {
        continue;
      }
      const cached = memo.get(run.id);
      let reading: PlanUsageReading | null;
      if (cached !== undefined && cached.size === size) {
        reading = cached.reading;
      } else {
        // lastOutputBytes lags the log file by up to a minute of output, so read
        // past the end: the server returns only what exists.
        const offset =
          cached === undefined
            ? Math.max(0, size - RUN_LOG_TAIL_BYTES)
            : Math.max(cached.size, size - RUN_LOG_TAIL_BYTES);
        const logRes = await doFetch(
          `/api/heartbeat-runs/${encodeURIComponent(run.id)}/log?offset=${offset}&limitBytes=${RUN_LOG_READ_BYTES}`,
          init,
        );
        if (!logRes.ok) {
          continue;
        }
        const logBody = await readJson(logRes);
        const content = isRecord(logBody) ? logBody.content : undefined;
        if (typeof content !== "string") {
          continue;
        }
        reading = latestRateLimitReading(content) ?? cached?.reading ?? null;
        memo.set(run.id, { size, reading });
      }
      if (reading !== null) {
        return reading;
      }
    }
    return null;
  } catch (err) {
    if (options.signal?.aborted) {
      throw err;
    }
    return null;
  }
}

/** The log size to read up to: lastOutputBytes, else logBytes, else 0. */
function runSize(run: RunRow): number {
  if (typeof run.lastOutputBytes === "number" && Number.isFinite(run.lastOutputBytes)) {
    return run.lastOutputBytes;
  }
  if (typeof run.logBytes === "number" && Number.isFinite(run.logBytes)) {
    return run.logBytes;
  }
  return 0;
}

/** The run's createdAt as an epoch time; rows that do not parse sort last. */
function runTime(run: RunRow): number {
  const time = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON body, returning `undefined` when it is not valid JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
