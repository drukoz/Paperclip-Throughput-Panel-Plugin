import type { MetricsSample } from "../types.ts";

/** One series line from a Prometheus text exposition response. */
export interface PromSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse Prometheus text exposition format. Malformed lines are skipped, never thrown. */
export function parsePrometheusText(text: string): PromSeries[] {
  const lines = text.split("\n");
  const results: PromSeries[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const series = parseLine(line);
    if (series !== null) results.push(series);
  }

  return results;
}

function parseLine(line: string): PromSeries | null {
  let nameEnd = line.length;
  let hasLabels = false;
  let labelStart = -1;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "{") {
      nameEnd = i;
      hasLabels = true;
      labelStart = i;
      break;
    }
    if (ch === " " || ch === "\t") {
      nameEnd = i;
      break;
    }
  }

  const name = line.slice(0, nameEnd);
  if (name === "") return null;

  let rest: string;
  let labels: Record<string, string> = {};

  if (hasLabels) {
    let inQuotes = false;
    let found = false;
    let labelEnd = -1;

    for (let i = labelStart + 1; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === "\\") {
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === "}") {
          labelEnd = i;
          found = true;
          break;
        }
      }
    }

    if (!found) return null;

    const block = line.slice(labelStart + 1, labelEnd);
    const parsed = parseLabels(block);
    if (parsed === null) return null;
    labels = parsed;

    rest = line.slice(labelEnd + 1);
  } else {
    rest = line.slice(nameEnd);
  }

  const trimmed = rest.trim();
  if (trimmed === "") return null;

  const valueStr = trimmed.split(/\s+/)[0];
  if (valueStr === undefined) return null;

  const value = parseValue(valueStr);
  if (value === null) return null;

  return { name, labels, value };
}

function parseLabels(block: string): Record<string, string> | null {
  const labels: Record<string, string> = {};
  let i = 0;
  const len = block.length;

  while (i < len) {
    while (i < len && (block[i] === " " || block[i] === "\t")) i++;
    if (i >= len) break;

    let key = "";
    while (i < len && block[i] !== "=") {
      key += block[i];
      i++;
    }
    if (i >= len) return null;
    i++;

    if (i >= len || block[i] !== '"') return null;
    i++;

    let value = "";
    let terminated = false;
    while (i < len) {
      const ch = block[i];
      if (ch === "\\") {
        if (i + 1 >= len) return null;
        const next = block[i + 1];
        if (next === "\\") value += "\\";
        else if (next === '"') value += '"';
        else if (next === "n") value += "\n";
        else return null;
        i += 2;
      } else if (ch === '"') {
        terminated = true;
        i++;
        break;
      } else {
        value += ch;
        i++;
      }
    }
    if (!terminated) return null;

    labels[key] = value;

    while (i < len && (block[i] === " " || block[i] === "\t")) i++;
    if (i < len) {
      if (block[i] === ",") {
        i++;
      } else {
        return null;
      }
    }
  }

  return labels;
}

function parseValue(s: string): number | null {
  if (s === "NaN") return Number.NaN;
  if (s === "+Inf" || s === "Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;

  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return null;
}

/** Pick the vLLM series we need and assemble one sample. Returns null if the required generation counter is absent. */
export function selectSample(
  series: PromSeries[],
  options: { at: number; modelName?: string },
): { sample: MetricsSample; modelName: string | null } | null {
  const filtered = series.filter((s) => {
    if (options.modelName === undefined) return true;
    return s.labels.model_name === options.modelName;
  });

  const genSeries = filtered.filter(
    (s) => s.name === "vllm:generation_tokens_total" && Number.isFinite(s.value),
  );
  if (genSeries.length === 0) return null;

  const generationTokens = genSeries.reduce((sum, s) => sum + s.value, 0);
  const firstGen = genSeries[0];
  const modelName = firstGen !== undefined ? (firstGen.labels.model_name ?? null) : null;

  const sumMetric = (name: string): number =>
    filtered
      .filter((s) => s.name === name && Number.isFinite(s.value))
      .reduce((sum, s) => sum + s.value, 0);

  const maxMetric = (name: string): number => {
    const values = filtered
      .filter((s) => s.name === name && Number.isFinite(s.value))
      .map((s) => s.value);
    return values.length > 0 ? Math.max(...values) : 0;
  };

  const sample: MetricsSample = {
    at: options.at,
    generationTokens,
    promptTokens: sumMetric("vllm:prompt_tokens_total"),
    prefixCacheHits: sumMetric("vllm:prefix_cache_hits_total"),
    prefixCacheQueries: sumMetric("vllm:prefix_cache_queries_total"),
    specAcceptedTokens: sumMetric("vllm:spec_decode_num_accepted_tokens_total"),
    specDraftTokens: sumMetric("vllm:spec_decode_num_draft_tokens_total"),
    numRequestsRunning: sumMetric("vllm:num_requests_running"),
    numRequestsWaiting: sumMetric("vllm:num_requests_waiting"),
    kvCacheUsage: maxMetric("vllm:kv_cache_usage_perc"),
  };

  return { sample, modelName };
}
