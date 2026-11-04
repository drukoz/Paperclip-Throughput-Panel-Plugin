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
      claudeAccount1Label: {
        type: "string",
        title: "Claude account 1: label",
        description: "Shown in the panel, for example the account's email address.",
      },
      claudeAccount1Token: {
        format: "secret-ref",
        title: "Claude account 1: token",
        description:
          "A Claude Code token for this account, from `claude setup-token`. Press + to store it as a Paperclip secret; a raw value pasted instead stays in these settings as plain text. Used only to ask Claude Code for the account's usage.",
      },
      claudeAccount2Label: {
        type: "string",
        title: "Claude account 2: label",
        description: "Shown in the panel, for example the account's email address.",
      },
      claudeAccount2Token: {
        format: "secret-ref",
        title: "Claude account 2: token",
        description:
          "A Claude Code token for this account, from `claude setup-token`. Press + to store it as a Paperclip secret; a raw value pasted instead stays in these settings as plain text. Used only to ask Claude Code for the account's usage.",
      },
      claudeAccount3Label: {
        type: "string",
        title: "Claude account 3: label",
        description: "Shown in the panel, for example the account's email address.",
      },
      claudeAccount3Token: {
        format: "secret-ref",
        title: "Claude account 3: token",
        description:
          "A Claude Code token for this account, from `claude setup-token`. Press + to store it as a Paperclip secret; a raw value pasted instead stays in these settings as plain text. Used only to ask Claude Code for the account's usage.",
      },
      claudePath: {
        type: "string",
        title: "Claude Code CLI path",
        description: "Absolute path of the claude executable the Claude usage checks run.",
        default: "/opt/homebrew/bin/claude",
      },
      claudeCheckMinutes: {
        type: "number",
        title: "Minutes between Claude usage checks",
        description:
          "Each check spends a little of that account's Claude usage. Checks run only while the panel is expanded.",
        default: 15,
        minimum: 5,
        maximum: 120,
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
