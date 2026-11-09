import { ServerKind, ServerStatus } from "../types.ts";
import type { ServerSnapshot } from "../types.ts";

/** The whole panel's health across servers. Numbers are fixed: never renumber or reuse one. */
export const PanelHealth = { Starting: 0, Ok: 1, Degraded: 2, Down: 3 } as const;
export type PanelHealth = (typeof PanelHealth)[keyof typeof PanelHealth];

/** Dot colour and tooltip for each panel health, using the shared palette. */
export const HEALTH_STYLE: Record<PanelHealth, { color: string; title: string }> = {
  [PanelHealth.Starting]: { color: "#a1a1aa", title: "Starting…" },
  [PanelHealth.Ok]: { color: "#22c55e", title: "All model servers connected" },
  [PanelHealth.Degraded]: { color: "#f59e0b", title: "Some model servers unreachable" },
  [PanelHealth.Down]: { color: "#ef4444", title: "Model servers unreachable" },
};

/**
 * The panel's health across a set of model servers: `Ok` when at least one is
 * reachable and none is down, `Degraded` when some are reachable and some are
 * down, `Down` when none is reachable and at least one is down, and `Starting`
 * otherwise (including an empty list, before the first scrape reports).
 */
export function panelHealth(servers: ServerSnapshot[]): PanelHealth {
  let ok = 0;
  let down = 0;
  for (const server of servers) {
    if (server.status === ServerStatus.Ok) ok += 1;
    else if (server.status === ServerStatus.Unreachable) down += 1;
  }
  if (ok > 0 && down === 0) return PanelHealth.Ok;
  if (ok > 0 && down > 0) return PanelHealth.Degraded;
  if (ok === 0 && down > 0) return PanelHealth.Down;
  return PanelHealth.Starting;
}

/**
 * Total generation tok/s across the panel: the sum of every live model on every
 * reachable server. Null when no reachable server reports a model with a live
 * instant rate (nothing to total yet).
 */
export function totalGeneration(servers: ServerSnapshot[]): number | null {
  let total: number | null = null;
  for (const server of servers) {
    if (server.status !== ServerStatus.Ok) continue;
    for (const model of server.models) {
      if (model.instant === null) continue;
      total = (total ?? 0) + model.instant.generation;
    }
  }
  return total;
}

/** Human name for a server's metrics format; empty for an undetected kind. */
export function kindLabel(kind: ServerKind): string {
  switch (kind) {
    case ServerKind.Vllm:
      return "vLLM";
    case ServerKind.LlamaCpp:
      return "llama.cpp";
    case ServerKind.Omlx:
      return "oMLX";
    default:
      return "";
  }
}

/**
 * Time to first token, in ms, as a readable duration: below a second as whole
 * milliseconds, at or above as one-decimal seconds. Null/undefined/non-finite
 * read as the em-dash placeholder.
 */
export function formatTtft(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
