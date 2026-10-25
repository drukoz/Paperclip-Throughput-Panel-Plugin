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
