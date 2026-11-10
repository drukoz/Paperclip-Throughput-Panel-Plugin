import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerKind, ServerStatus } from "../types.ts";
import type { ServerSnapshot, ThroughputSnapshot } from "../types.ts";
import {
  PanelHealth,
  formatTtft,
  kindLabel,
  panelHealth,
  totalGeneration,
} from "./servers-view.ts";

function model(generation: number | null): ThroughputSnapshot {
  return {
    status: ServerStatus.Ok,
    lastSampleAt: null,
    error: null,
    instant: generation === null ? null : { generation, prompt: 0 },
    averages: { "1m": null, "5m": null, "15m": null },
    perRequestTokensPerSec: { "1m": null, "5m": null, "15m": null },
    timeToFirstTokenMs: { "1m": null, "5m": null, "15m": null },
    historySpanMs: null,
    numRequestsRunning: null,
    numRequestsWaiting: null,
    kvCacheUsagePct: null,
    prefixCacheHitRatePct: null,
    mtpAcceptanceRatePct: null,
    sparkline: [],
    modelName: null,
  };
}

function server(status: ServerStatus, models: ThroughputSnapshot[]): ServerSnapshot {
  return {
    slot: 1,
    label: "server",
    kind: ServerKind.Unknown,
    status,
    error: null,
    lastSampleAt: null,
    models,
  };
}

test("panelHealth", () => {
  assert.equal(panelHealth([]), PanelHealth.Starting);
  assert.equal(panelHealth([server(ServerStatus.Starting, [])]), PanelHealth.Starting);
  assert.equal(
    panelHealth([server(ServerStatus.Ok, [model(1)]), server(ServerStatus.Starting, [])]),
    PanelHealth.Ok,
  );
  assert.equal(
    panelHealth([
      server(ServerStatus.Ok, [model(1)]),
      server(ServerStatus.Unreachable, []),
    ]),
    PanelHealth.Degraded,
  );
  assert.equal(panelHealth([server(ServerStatus.Unreachable, [])]), PanelHealth.Down);
});

test("totalGeneration sums ok servers only", () => {
  const servers = [
    server(ServerStatus.Ok, [model(10), model(5.5)]),
    server(ServerStatus.Unreachable, [model(100)]),
  ];
  assert.equal(totalGeneration(servers), 15.5);
});

test("totalGeneration is null without live models", () => {
  assert.equal(totalGeneration([server(ServerStatus.Ok, [model(null)])]), null);
});

test("kindLabel", () => {
  assert.equal(kindLabel(ServerKind.Vllm), "vLLM");
  assert.equal(kindLabel(ServerKind.LlamaCpp), "llama.cpp");
  assert.equal(kindLabel(ServerKind.Omlx), "oMLX");
  assert.equal(kindLabel(ServerKind.Unknown), "");
});

test("formatTtft", () => {
  assert.equal(formatTtft(null), "—");
  assert.equal(formatTtft(420.4), "420 ms");
  assert.equal(formatTtft(1530), "1.5 s");
  assert.equal(formatTtft(Number.NaN), "—");
});
