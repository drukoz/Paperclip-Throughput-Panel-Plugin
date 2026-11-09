import type { AverageWindowKey } from "./windows.ts";

/** Lifecycle of one model server's polling. Numbers are fixed: never renumber or reuse one. */
export const ServerStatus = { Starting: 0, Ok: 1, Unreachable: 2 } as const;
export type ServerStatus = (typeof ServerStatus)[keyof typeof ServerStatus];

/** Which metrics format a server publishes. Numbers are fixed: never renumber or reuse one. */
export const ServerKind = { Unknown: 0, Vllm: 1, LlamaCpp: 2 } as const;
export type ServerKind = (typeof ServerKind)[keyof typeof ServerKind];

/** One parsed scrape of the vLLM `/metrics` endpoint. */
export interface MetricsSample {
  /** `Date.now()` when the scrape completed, in ms. */
  at: number;
  /** `vllm:generation_tokens_total` */
  generationTokens: number;
  /** `vllm:prompt_tokens_total` */
  promptTokens: number;
  /** `vllm:prefix_cache_hits_total` */
  prefixCacheHits: number;
  /** `vllm:prefix_cache_queries_total` */
  prefixCacheQueries: number;
  /** `vllm:spec_decode_num_accepted_tokens_total` */
  specAcceptedTokens: number;
  /** `vllm:spec_decode_num_draft_tokens_total` */
  specDraftTokens: number;
  /** `vllm:num_requests_running` */
  numRequestsRunning: number;
  /** `vllm:num_requests_waiting` */
  numRequestsWaiting: number;
  /** `vllm:kv_cache_usage_perc`, a ratio in 0..1 (max over engines), null when the gauge is absent. */
  kvCacheUsage: number | null;
  /** `vllm:inter_token_latency_seconds_count` */
  decodeTokens: number;
  /** `vllm:inter_token_latency_seconds_sum` */
  decodeSeconds: number;
  /** `vllm:time_to_first_token_seconds_sum` */
  firstTokenSeconds: number;
  /** `vllm:time_to_first_token_seconds_count` */
  firstTokenCount: number;
}

/** Instantaneous and windowed generation/prompt throughput. */
export interface RatePair {
  /** Generation tokens per second. */
  generation: number;
  /** Prompt tokens per second. */
  prompt: number;
}

/** One point on the generation-throughput sparkline. */
export interface SparklinePoint {
  /** `Date.now()` ms of the sample that ends this interval. */
  at: number;
  /** Generation tokens per second over the interval ending at `at`. */
  tokensPerSec: number;
}

/** What the worker hands the UI on each `throughput` data read. */
export interface ThroughputSnapshot {
  /** `Starting` before the first scrape completes. */
  status: ServerStatus;
  /** ISO 8601 time of the most recent successful scrape, or null. */
  lastSampleAt: string | null;
  /** Message from the most recent failed scrape, or null when healthy. */
  error: string | null;
  /** tok/s over the most recent poll interval. Null until two samples exist. */
  instant: RatePair | null;
  /**
   * tok/s averaged over each selectable trailing window, counting only the
   * intervals in which tokens were produced — idle gaps are excluded, so the
   * readout is throughput while the server was working. An entry is null
   * until the history holds two samples, and every entry is null when the
   * status is not `ok`. A window with no token-producing interval reads 0.
   */
  averages: Record<AverageWindowKey, RatePair | null>;
  /** tok/s one request sees while decoding, per window: Δ decodeTokens / Δ decodeSeconds. Null when the window has no decode time or status is not Ok. */
  perRequestTokensPerSec: Record<AverageWindowKey, number | null>;
  /** Mean time to first token in ms of requests in the window: 1000 · Δ firstTokenSeconds / Δ firstTokenCount. Null when none, or status is not Ok. */
  timeToFirstTokenMs: Record<AverageWindowKey, number | null>;
  /** Span of retained history in ms (newest sample minus oldest), or null with fewer than two samples. */
  historySpanMs: number | null;
  numRequestsRunning: number | null;
  numRequestsWaiting: number | null;
  /** KV cache usage as a percentage, 0..100. */
  kvCacheUsagePct: number | null;
  /** Cumulative prefix-cache hit rate as a percentage, 0..100. */
  prefixCacheHitRatePct: number | null;
  /** Cumulative MTP (speculative decode) acceptance rate as a percentage, 0..100. */
  mtpAcceptanceRatePct: number | null;
  /** Generation tok/s over the full retained history (up to 15 minutes), oldest first. */
  sparkline: SparklinePoint[];
  /** `model_name` label the sample was read from, or null. */
  modelName: string | null;
}

/** One model's sample from one scrape. */
export interface ModelSample {
  /** `model_name` label (vLLM), or null when the server publishes none (llama.cpp). */
  modelName: string | null;
  sample: MetricsSample;
}

/** What `selectSamples` returns for one scrape. */
export interface SelectedSamples {
  kind: ServerKind;
  /** One entry per model, sorted by model name; never empty. */
  models: ModelSample[];
}

/** One configured model server, as the panel shows it. */
export interface ServerSnapshot {
  /** Settings slot, 1..3: the stable key for the UI. */
  slot: number;
  /** Display name from the settings, for example "hpcserver" or "A9 Mega". */
  label: string;
  /** Unknown until the first successful scrape. */
  kind: ServerKind;
  status: ServerStatus;
  /** Message from the most recent failed scrape, or null. */
  error: string | null;
  /** ISO 8601 time of the most recent successful scrape, or null. */
  lastSampleAt: string | null;
  /** One entry per model the server reported, sorted by model name. Empty before the first successful scrape. */
  models: ThroughputSnapshot[];
}

/** What the worker's `servers` data handler returns. */
export interface ServersSnapshot {
  /** Enabled servers in slot order. */
  servers: ServerSnapshot[];
}
