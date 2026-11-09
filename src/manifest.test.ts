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
    | Record<string, { type?: string; format?: string; default?: number | string; minimum?: number; maximum?: number }>
    | undefined;
  for (const n of [1, 2, 3]) {
    assert.equal(properties?.[`claudeAccount${n}Label`]?.type, "string");
    // A secret field: the settings page shows its picker only for this format, and the
    // host's Ajv check would reject the stored { type: "secret_ref" } object under type "string".
    assert.equal(properties?.[`claudeAccount${n}Token`]?.format, "secret-ref");
    assert.equal(properties?.[`claudeAccount${n}Token`]?.type, undefined);
  }
  assert.equal(properties?.claudePath?.default, "/opt/homebrew/bin/claude");
  assert.equal(properties?.claudeCheckMinutes?.default, 15);
  assert.equal(properties?.claudeCheckMinutes?.minimum, 5);
  assert.equal(properties?.claudeCheckMinutes?.maximum, 120);
});

test("manifest declares three model servers", () => {
  const properties = manifest.instanceConfigSchema?.properties as
    | Record<string, { type?: string; format?: string; default?: string }>
    | undefined;
  assert.equal(properties?.server1Label?.default, "hpcserver");
  assert.equal(properties?.server2Label?.default, "A9 Mega");
  assert.equal(properties?.server2MetricsUrl?.default, "http://127.0.0.1:18082/metrics");
  assert.equal(properties?.server3Label?.default, "M5U");
  assert.equal(properties?.server3MetricsUrl?.default, "http://127.0.0.1:18083/admin/api/activity");
  // The token fields are secret fields: the settings page shows their picker only for
  // this format, and the host's Ajv check rejects the stored { type: "secret_ref" }
  // object under type "string".
  for (const key of ["authToken", "server2Token", "server3Token"]) {
    assert.equal(properties?.[key]?.format, "secret-ref");
    assert.equal(properties?.[key]?.type, undefined);
  }
  // Blank model filter means every model, so the field has no default.
  assert.equal(properties?.modelName?.default, undefined);
});
