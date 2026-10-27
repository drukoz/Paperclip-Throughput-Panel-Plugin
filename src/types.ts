import type { AverageWindowKey } from "./windows.ts";

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
  /** `vllm:kv_cache_usage_perc`, a ratio in 0..1 */
  kvCacheUsage: number;
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
  /** `starting` before the first scrape completes. */
  status: "starting" | "ok" | "unreachable";
  /** ISO 8601 time of the most recent successful scrape, or null. */
  lastSampleAt: string | null;
  /** Message from the most recent failed scrape, or null when healthy. */
  error: string | null;
  /** tok/s over the most recent poll interval. Null until two samples exist. */
  instant: RatePair | null;
  /**
   * tok/s averaged over each selectable trailing window. An entry is null
   * until the history holds two samples, and every entry is null when the
   * status is not `ok`.
   */
  averages: Record<AverageWindowKey, RatePair | null>;
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
