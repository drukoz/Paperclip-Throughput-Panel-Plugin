import type { MetricsSample, RatePair, SparklinePoint } from "../types.ts";
import { MAX_AVERAGE_WINDOW_MS } from "../windows.ts";

export interface ThroughputWindowOptions {
  /** How much history to retain, in ms. Defaults to MAX_AVERAGE_WINDOW_MS (15 minutes). */
  retentionMs?: number;
}

const COUNTER_FIELDS = [
  "generationTokens",
  "promptTokens",
  "prefixCacheHits",
  "prefixCacheQueries",
  "specAcceptedTokens",
  "specDraftTokens",
  "decodeTokens",
  "decodeSeconds",
  "firstTokenSeconds",
  "firstTokenCount",
] as const;

export type CounterField = (typeof COUNTER_FIELDS)[number];

function rateBetween(a: MetricsSample, b: MetricsSample): RatePair | null {
  const dt = (b.at - a.at) / 1000;
  if (dt <= 0) return null;
  return {
    generation: Math.max(0, (b.generationTokens - a.generationTokens) / dt),
    prompt: Math.max(0, (b.promptTokens - a.promptTokens) / dt),
  };
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export class ThroughputWindow {
  private retentionMs: number;
  private samples: MetricsSample[];

  constructor(options?: ThroughputWindowOptions) {
    this.retentionMs = options?.retentionMs ?? MAX_AVERAGE_WINDOW_MS;
    this.samples = [];
  }

  push(sample: MetricsSample): void {
    const latest = this.latest();
    if (latest === null) {
      this.samples.push(sample);
      return;
    }
    if (sample.at <= latest.at) return;
    if (COUNTER_FIELDS.some((field) => sample[field] < latest[field])) {
      this.samples = [sample];
      return;
    }
    this.samples.push(sample);
    const cutoff = sample.at - this.retentionMs;
    while (this.samples.length > 2 && this.samples[0]!.at < cutoff) {
      this.samples.shift();
    }
  }

  size(): number {
    return this.samples.length;
  }

  latest(): MetricsSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /** Span of retained history in ms, or null with fewer than two samples. */
  spanMs(): number | null {
    const n = this.samples.length;
    if (n < 2) return null;
    return this.samples[n - 1]!.at - this.samples[0]!.at;
  }

  instantRates(): RatePair | null {
    const n = this.samples.length;
    if (n < 2) return null;
    return rateBetween(this.samples[n - 2]!, this.samples[n - 1]!);
  }

  /**
   * Generation and prompt tok/s averaged over the *active* intervals inside
   * the trailing `windowMs`: an interval counts for a series only when that
   * series' counter advanced across it, so idle gaps dilute neither rate.
   * Null with fewer than two samples. A series with no active interval in
   * the window reads 0.
   */
  averageRates(windowMs: number = 60_000): RatePair | null {
    const n = this.samples.length;
    if (n < 2) return null;
    const newest = this.samples[n - 1]!;
    const cutoff = newest.at - windowMs;

    // Start at the first interval whose opening sample is inside the window.
    // When no sample but `newest` is (one long gap), average the final
    // interval alone rather than reporting nothing.
    let first = n - 2;
    for (let i = 0; i < n - 1; i++) {
      if (this.samples[i]!.at >= cutoff) {
        first = i;
        break;
      }
    }

    let generationTokens = 0;
    let generationSeconds = 0;
    let promptTokens = 0;
    let promptSeconds = 0;
    for (let i = first + 1; i < n; i++) {
      const a = this.samples[i - 1]!;
      const b = this.samples[i]!;
      const dt = (b.at - a.at) / 1000;
      if (dt <= 0) continue;
      const generation = b.generationTokens - a.generationTokens;
      if (generation > 0) {
        generationTokens += generation;
        generationSeconds += dt;
      }
      const prompt = b.promptTokens - a.promptTokens;
      if (prompt > 0) {
        promptTokens += prompt;
        promptSeconds += dt;
      }
    }

    return {
      generation: generationSeconds > 0 ? generationTokens / generationSeconds : 0,
      prompt: promptSeconds > 0 ? promptTokens / promptSeconds : 0,
    };
  }

  /**
   * Δnumerator / Δdenominator between the first sample inside the trailing `windowMs`
   * and the newest one (when only the newest is inside, the one before it). Null with
   * fewer than two samples or when Δdenominator <= 0.
   */
  ratioOver(windowMs: number, numerator: CounterField, denominator: CounterField): number | null {
    const n = this.samples.length;
    if (n < 2) return null;
    const newest = this.samples[n - 1]!;
    const cutoff = newest.at - windowMs;

    let first = n - 2;
    for (let i = 0; i < n - 1; i++) {
      if (this.samples[i]!.at >= cutoff) {
        first = i;
        break;
      }
    }
    const base = this.samples[first]!;

    const dDen = newest[denominator] - base[denominator];
    if (dDen <= 0) return null;
    return Math.max(0, newest[numerator] - base[numerator]) / dDen;
  }

  cumulativeRates(): {
    prefixCacheHitRatePct: number | null;
    mtpAcceptanceRatePct: number | null;
  } {
    const latest = this.latest();
    if (latest === null) {
      return { prefixCacheHitRatePct: null, mtpAcceptanceRatePct: null };
    }
    return {
      prefixCacheHitRatePct:
        latest.prefixCacheQueries > 0
          ? clampPct((latest.prefixCacheHits / latest.prefixCacheQueries) * 100)
          : null,
      mtpAcceptanceRatePct:
        latest.specDraftTokens > 0
          ? clampPct((latest.specAcceptedTokens / latest.specDraftTokens) * 100)
          : null,
    };
  }

  sparkline(): SparklinePoint[] {
    const points: SparklinePoint[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const rate = rateBetween(this.samples[i - 1]!, this.samples[i]!);
      if (rate === null) continue;
      points.push({ at: this.samples[i]!.at, tokensPerSec: rate.generation });
    }
    return points;
  }
}
