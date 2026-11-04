import { test } from "node:test";
import assert from "node:assert/strict";
import manifest from "./manifest.ts";

test("manifest declares the app shell overlay slot", () => {
  assert.equal(manifest.ui?.slots?.[0]?.type, "appShellOverlay");
  assert.equal(manifest.ui?.slots?.[0]?.exportName, "ThroughputPanel");
});

test("manifest declares the capabilities the panel needs", () => {
  for (const cap of ["http.outbound", "secrets.read-ref", "ui.action.register"]) {
    assert.ok(manifest.capabilities.includes(cap as never), `missing ${cap}`);
  }
});

test("manifest entrypoints match the build output paths", () => {
  assert.equal(manifest.entrypoints.worker, "dist/worker.js");
  assert.equal(manifest.entrypoints.ui, "dist/ui");
});

test("manifest declares the poll interval bounds the worker enforces", () => {
  const properties = manifest.instanceConfigSchema?.properties as
    | Record<string, { default?: number; minimum?: number; maximum?: number }>
    | undefined;
  const pollIntervalMs = properties?.pollIntervalMs;
  assert.equal(pollIntervalMs?.default, 5000);
  assert.equal(pollIntervalMs?.minimum, 1000);
  assert.equal(pollIntervalMs?.maximum, 60000);
});

test("manifest declares the Claude check settings", () => {
  const properties = manifest.instanceConfigSchema?.properties as
    | Record<string, { type?: string; default?: number | string; minimum?: number; maximum?: number }>
    | undefined;
  for (const n of [1, 2, 3]) {
    assert.equal(properties?.[`claudeAccount${n}Label`]?.type, "string");
    assert.equal(properties?.[`claudeAccount${n}Token`]?.type, "string");
  }
  assert.equal(properties?.claudePath?.default, "/opt/homebrew/bin/claude");
  assert.equal(properties?.claudeCheckMinutes?.default, 15);
  assert.equal(properties?.claudeCheckMinutes?.minimum, 5);
  assert.equal(properties?.claudeCheckMinutes?.maximum, 120);
});
