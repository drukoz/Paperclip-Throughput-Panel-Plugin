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
/** Bytes each step back covers when a read finds no plan-usage event. */
export const RUN_LOG_BACK_BYTES = 524_288;
/** How far each step back reads into the previous read, so an event line cut at its start is whole in one of the two. */
export const RUN_LOG_OVERLAP_BYTES = 65_536;
/** Most steps back per run and call; with the tail read, about 1.75 MiB before lastOutputBytes is searched. */
export const RUN_LOG_BACK_STEPS = 3;

/** A run row kept from the heartbeat-runs response, with the fields the reader uses. */
interface RunRow {
  id: string;
  createdAt: unknown;
  logBytes: unknown;
  lastOutputBytes: unknown;
  finishedAt: unknown;
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
          runs.push({ id: row.id, createdAt: row.createdAt, logBytes: row.logBytes, lastOutputBytes: row.lastOutputBytes, finishedAt: row.finishedAt });
        }
      }
    }
    runs.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || 0);
    let latest: PlanUsageReading | null = null;
    for (const run of runs.slice(0, RUN_LOOKBACK)) {
      // A run that ended before the newest reading found so far cannot hold a newer one.
      const finished = typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : NaN;
      if (latest !== null && finished < timeOf(latest.at)) {
        continue;
      }
      const size = runSize(run);
      if (size <= 0) {
        continue;
      }
      const cached = memo.get(run.id);
      let reading: PlanUsageReading | null;
      if (cached !== undefined && cached.size === size) {
        reading = cached.reading;
      } else {
        // Bytes before `floor` were searched by an earlier call.
        const floor = cached === undefined ? 0 : cached.size;
        // lastOutputBytes lags the log file by up to a minute of output, so read
        // past the end: the server returns only what exists.
        let offset = Math.max(floor, size - RUN_LOG_TAIL_BYTES);
        let limitBytes = RUN_LOG_READ_BYTES;
        let found: PlanUsageReading | null = null;
        let failed = false;
        // Claude Code writes a rate_limit_event only when the numbers change, so
        // the last one can sit far before the end: step back until one turns up.
        for (let step = 0; ; step += 1) {
          const content = await readLogSlice(doFetch, init, run.id, offset, limitBytes);
          if (content === null) {
            failed = true;
            break;
          }
          found = latestRateLimitReading(content);
          if (found !== null || offset <= floor || step === RUN_LOG_BACK_STEPS) {
            break;
          }
          const start = Math.max(floor, offset - RUN_LOG_BACK_BYTES);
          limitBytes = offset - start + RUN_LOG_OVERLAP_BYTES;
          offset = start;
        }
        if (failed) {
          continue;
        }
        reading = found ?? cached?.reading ?? null;
        memo.set(run.id, { size, reading });
      }
      // Claude runs overlap: an older run can still be writing after a newer one
      // has ended, so keep the reading observed last, not the newest run's.
      if (reading !== null && (latest === null || timeOf(reading.at) > timeOf(latest.at))) {
        latest = reading;
      }
    }
    return latest;
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

/** An ISO 8601 time as epoch ms; a value that does not parse counts as the earliest. */
function timeOf(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One slice of a run log: `limitBytes` bytes from `offset`, or null when Paperclip does not return one. */
async function readLogSlice(
  doFetch: typeof fetch,
  init: RequestInit,
  runId: string,
  offset: number,
  limitBytes: number,
): Promise<string | null> {
  const res = await doFetch(
    `/api/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=${limitBytes}`,
    init,
  );
  if (!res.ok) {
    return null;
  }
  const body = await readJson(res);
  const content = isRecord(body) ? body.content : undefined;
  return typeof content === "string" ? content : null;
}

/** Reads a JSON body, returning `undefined` when it is not valid JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
