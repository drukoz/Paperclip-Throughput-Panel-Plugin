import type { ModelSample, SelectedSamples } from "../types.ts";
import { ServerKind } from "../types.ts";

/** One request in its prompt phase. */
export interface OmlxPrefillRow {
  requestId: string;
  processed: number;
}

/** One request generating tokens. */
export interface OmlxGeneratingRow {
  requestId: string;
  generatedTokens: number;
  tokensPerSecond: number;
  promptTokens: number;
}

/** One loaded model's live activity. */
export interface OmlxModelActivity {
  id: string;
  activeRequests: number;
  waitingRequests: number;
  prefilling: OmlxPrefillRow[];
  generating: OmlxGeneratingRow[];
}

/** `GET /admin/api/activity`, reduced to what the panel reads. */
export interface OmlxActivity {
  models: OmlxModelActivity[];
}

/** `GET /api/status` session totals, reduced to what the panel reads. */
export interface OmlxStatus {
  totalCompletionTokens: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  defaultModel: string | null;
}

/** Per-model running totals the panel's rate window reads; only ever grow. */
interface ModelCounters {
  generation: number;
  prompt: number;
  decodeTokens: number;
  decodeSeconds: number;
}

/** The last-seen state of one in-flight request, keyed by model id and request id. */
interface RequestState {
  model: string;
  generated: number;
  processed: number;
  generating: boolean;
}

/** One entry of the returned model list: the model to show and the counters to read. */
interface OutputEntry {
  name: string | null;
  key: string;
  running: number;
  waiting: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Reduce the JSON body of `GET /admin/api/activity` to what the panel reads.
 * Never throws: a non-JSON body, a Prometheus text body or an error object gives null.
 */
export function parseOmlxActivity(text: string): OmlxActivity | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(root)) return null;

  const activeModels = root["active_models"];
  if (!isObject(activeModels)) return null;
  const rawModels = activeModels["models"];
  if (!Array.isArray(rawModels)) return null;

  const models: OmlxModelActivity[] = [];
  for (const entry of rawModels) {
    if (!isObject(entry)) continue;
    if (!nonEmptyString(entry["id"])) continue;

    const activeRaw = entry["active_requests"];
    const waitingRaw = entry["waiting_requests"];

    const prefilling: OmlxPrefillRow[] = [];
    const rawPrefill = entry["prefilling"];
    if (Array.isArray(rawPrefill)) {
      for (const row of rawPrefill) {
        if (!isObject(row)) continue;
        if (!nonEmptyString(row["request_id"])) continue;
        if (!isCount(row["processed"])) continue;
        prefilling.push({ requestId: row["request_id"], processed: row["processed"] });
      }
    }

    const generating: OmlxGeneratingRow[] = [];
    const rawGenerating = entry["generating"];
    if (Array.isArray(rawGenerating)) {
      for (const row of rawGenerating) {
        if (!isObject(row)) continue;
        if (!nonEmptyString(row["request_id"])) continue;
        if (!isCount(row["generated_tokens"])) continue;
        const tpsRaw = row["tokens_per_second"];
        const promptRaw = row["prompt_tokens"];
        generating.push({
          requestId: row["request_id"],
          generatedTokens: row["generated_tokens"],
          tokensPerSecond: isCount(tpsRaw) ? tpsRaw : 0,
          promptTokens: isCount(promptRaw) ? promptRaw : 0,
        });
      }
    }

    models.push({
      id: entry["id"],
      activeRequests: isCount(activeRaw) ? activeRaw : 0,
      waitingRequests: isCount(waitingRaw) ? waitingRaw : 0,
      prefilling,
      generating,
    });
  }

  return { models };
}

/**
 * Reduce a parsed `GET /api/status` body to the session totals the panel reads.
 * Never throws; null unless the three totals are all present, finite and non-negative.
 */
export function parseOmlxStatus(value: unknown): OmlxStatus | null {
  if (!isObject(value)) return null;
  const completion = value["total_completion_tokens"];
  const prompt = value["total_prompt_tokens"];
  const cached = value["total_cached_tokens"];
  if (!isCount(completion) || !isCount(prompt) || !isCount(cached)) return null;

  const defaultRaw = value["default_model"];
  return {
    totalCompletionTokens: completion,
    totalPromptTokens: prompt,
    totalCachedTokens: cached,
    defaultModel: nonEmptyString(defaultRaw) ? defaultRaw : null,
  };
}

/**
 * Turns the oMLX activity and status reads into the panel's `SelectedSamples`.
 *
 * oMLX has no cumulative counters, so this rebuilds monotonic per-model counters
 * from the per-request snapshots in `/admin/api/activity`, and credits the
 * completion tokens that only appear in `/api/status` once a request finishes.
 * The counters only ever grow (except the cache fields, which rebase on a server
 * restart) so the downstream rate window never discards its history.
 */
export class OmlxCounters {
  private counters: Map<string, ModelCounters> = new Map();
  private requests: Map<string, RequestState> = new Map();
  // Session-total baseline: completion tokens at the last rebase, and the
  // completion/prompt totals last seen. Both null until the first status.
  private baseCompletion: number | null = null;
  private lastCompletion: number | null = null;
  // Completion tokens of requests we saw live that have since finished, and the
  // tail credit already booked, so the status delta is credited exactly once.
  private finishedLive = 0;
  private tailCredited = 0;
  private cacheHits = 0;
  private cacheQueries = 0;

  private countersFor(id: string): ModelCounters {
    let c = this.counters.get(id);
    if (c === undefined) {
      c = { generation: 0, prompt: 0, decodeTokens: 0, decodeSeconds: 0 };
      this.counters.set(id, c);
    }
    return c;
  }

  /** Fold one poll's activity and status into the running counters. Never throws. */
  update(activity: OmlxActivity, status: OmlxStatus | null, at: number): SelectedSamples {
    const seen = new Set<string>();
    let finishedModel: string | null = null;

    // 1. Fold per-request rows into per-model counters, tracking deltas against
    // the last-seen state of each request so repeated polls never double count.
    for (const m of activity.models) {
      const c = this.countersFor(m.id);

      for (const p of m.prefilling) {
        const key = `${m.id}\n${p.requestId}`;
        seen.add(key);
        const prev = this.requests.get(key);
        const base = prev?.processed ?? 0;
        if (p.processed > base) c.prompt += p.processed - base;
        this.requests.set(key, {
          model: m.id,
          generated: prev?.generated ?? 0,
          processed: Math.max(base, p.processed),
          generating: false,
        });
      }

      for (const g of m.generating) {
        const key = `${m.id}\n${g.requestId}`;
        seen.add(key);
        const prev = this.requests.get(key);
        const base = prev?.processed ?? 0;
        // Credit the prompt the first time a request is seen generating, in case
        // it skipped the prefill phase (a poll caught it already decoding).
        if ((prev === undefined || !prev.generating) && g.promptTokens > base) {
          c.prompt += g.promptTokens - base;
        }
        const d = g.generatedTokens - (prev?.generated ?? 0);
        if (d > 0) {
          c.generation += d;
          c.decodeTokens += d;
          if (g.tokensPerSecond > 0) c.decodeSeconds += d / g.tokensPerSecond;
        }
        this.requests.set(key, {
          model: m.id,
          generated: Math.max(prev?.generated ?? 0, g.generatedTokens),
          processed: Math.max(base, g.promptTokens),
          generating: true,
        });
      }
    }

    // 2. A request absent from this poll has completed: bank its generated tokens
    // as live, and remember its model so the tail credit lands on the right model.
    for (const [key, req] of this.requests) {
      if (seen.has(key)) continue;
      this.finishedLive += req.generated;
      if (finishedModel === null) finishedModel = req.model;
      this.requests.delete(key);
    }

    // 3. Read the status totals. The first status, or a lower completion total
    // than last time, means the server restarted: rebase so counters never drop.
    if (status !== null) {
      const s = status.totalCompletionTokens;
      if (this.lastCompletion === null || s < this.lastCompletion) {
        this.baseCompletion = s;
        this.finishedLive = 0;
        this.tailCredited = 0;
      }
      this.lastCompletion = s;
      this.cacheHits = status.totalCachedTokens;
      this.cacheQueries = status.totalPromptTokens;
    }

    // 4. Build the output list, sorted by model id. With no model loaded, emit a
    // single fallback entry named after the status default model (null if none).
    const outputs: OutputEntry[] = [];
    if (activity.models.length === 0) {
      const name = status?.defaultModel ?? null;
      const key = status?.defaultModel ?? "";
      this.countersFor(key);
      outputs.push({ name, key, running: 0, waiting: 0 });
    } else {
      for (const m of activity.models) {
        outputs.push({ name: m.id, key: m.id, running: m.activeRequests, waiting: m.waitingRequests });
      }
      outputs.sort((a, b) => a.key.localeCompare(b.key));
    }

    // 5. Tail credit. oMLX adds a request's tokens to the status total only when
    // it completes, so tokens generated after the last poll that saw a request
    // live land only in the status delta. Credit the unexplained remainder once,
    // subtracting what is already accounted for (live finishes, still-active
    // requests, and credit already booked) so nothing is counted twice.
    if (this.baseCompletion !== null && this.lastCompletion !== null) {
      let liveActive = 0;
      for (const req of this.requests.values()) liveActive += req.generated;
      const credit =
        this.lastCompletion - this.baseCompletion - this.finishedLive - liveActive - this.tailCredited;
      if (credit > 0) {
        const targetKey = finishedModel !== null ? finishedModel : outputs[0]?.key;
        if (targetKey !== undefined) this.countersFor(targetKey).generation += credit;
        this.tailCredited += credit;
      }
    }

    // 6. Emit one sample per output entry, in output order.
    const models: ModelSample[] = outputs.map((o) => {
      const c = this.countersFor(o.key);
      return {
        modelName: o.name,
        sample: {
          at,
          generationTokens: c.generation,
          promptTokens: c.prompt,
          prefixCacheHits: this.cacheHits,
          prefixCacheQueries: this.cacheQueries,
          specAcceptedTokens: 0,
          specDraftTokens: 0,
          numRequestsRunning: o.running,
          numRequestsWaiting: o.waiting,
          kvCacheUsage: null,
          decodeTokens: c.decodeTokens,
          decodeSeconds: c.decodeSeconds,
          firstTokenSeconds: 0,
          firstTokenCount: 0,
        },
      };
    });

    return { kind: ServerKind.Omlx, models };
  }
}
