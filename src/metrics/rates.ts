import type { MetricsSample, RatePair, SparklinePoint } from "../types.ts";

export interface ThroughputWindowOptions {
  /** How much history to retain, in ms. Defaults to 300_000 (5 minutes). */
  retentionMs?: number;
}

const COUNTER_FIELDS = [
  "generationTokens",
  "promptTokens",
  "prefixCacheHits",
  "prefixCacheQueries",
  "specAcceptedTokens",
  "specDraftTokens",
] as const;

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
    this.retentionMs = options?.retentionMs ?? 300_000;
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

  instantRates(): RatePair | null {
    const n = this.samples.length;
    if (n < 2) return null;
    return rateBetween(this.samples[n - 2]!, this.samples[n - 1]!);
  }

  averageRates(windowMs: number = 60_000): RatePair | null {
    const n = this.samples.length;
    if (n < 2) return null;
    const newest = this.samples[n - 1]!;
    const cutoff = newest.at - windowMs;
    let base = newest;
    for (const candidate of this.samples) {
      if (candidate.at >= cutoff) {
        base = candidate;
        break;
      }
    }
    if (base === newest) {
      base = this.samples[n - 2]!;
    }
    return rateBetween(base, newest);
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
