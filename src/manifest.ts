import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "rukoz.throughput-panel",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Model Throughput Panel",
  description: "Live tokens/sec readout for the local vLLM model server.",
  author: "Rukoz Ent",
  categories: ["ui"],
  minimumHostVersion: "2026.1023.0",
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "ui.action.register",
    "instance.settings.register",
  ],
  entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      metricsUrl: {
        type: "string",
        title: "Metrics URL",
        description: "Prometheus metrics endpoint of the vLLM server.",
        default: "http://127.0.0.1:18081/metrics",
      },
      authToken: {
        type: "string",
        title: "Bearer token",
        description:
          "Optional. Sent as `Authorization: Bearer <token>`. Prefer a secret reference over a literal value.",
      },
      modelName: {
        type: "string",
        title: "Model name label",
        description: "Value of the `model_name` label to read.",
        default: "swift-1.5",
      },
      pollIntervalMs: {
        type: "number",
        title: "Poll interval (ms)",
        default: 5000,
        minimum: 1000,
        maximum: 60000,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "appShellOverlay",
        id: "throughput-panel",
        displayName: "Model Throughput",
        exportName: "ThroughputPanel",
      },
    ],
  },
};

export default manifest;
