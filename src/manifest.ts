import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "rukoz.throughput-panel",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Model Throughput Panel",
  description: "Live tokens/sec readout for every local model server (vLLM and llama.cpp).",
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
      server1Label: {
        type: "string",
        title: "Server 1: label",
        description: "Shown in the panel.",
        default: "hpcserver",
      },
      metricsUrl: {
        type: "string",
        title: "Server 1: metrics URL",
        description:
          "Prometheus /metrics endpoint of the first model server (vLLM or llama.cpp).",
        default: "http://127.0.0.1:18081/metrics",
      },
      authToken: {
        format: "secret-ref",
        title: "Server 1: token",
        description:
          "Optional. Sent as Authorization: Bearer <token>. hpcserver needs none.",
      },
      modelName: {
        type: "string",
        title: "Server 1: model filter",
        description:
          "Optional. Show only this model_name. Leave blank to show every model the server serves.",
      },
      server2Label: {
        type: "string",
        title: "Server 2: label",
        description: "Shown in the panel.",
        default: "A9 Mega",
      },
      server2MetricsUrl: {
        type: "string",
        title: "Server 2: metrics URL",
        description:
          "The A9 Mega (Strix Halo). Save it empty to hide this server.",
        default: "http://127.0.0.1:18082/metrics",
      },
      server2Token: {
        format: "secret-ref",
        title: "Server 2: token",
        description:
          "The A9 Mega's API key: pick the Paperclip secret that the 'A9 Mega local endpoint' AI connection uses, or press + to store it. Without it the A9 answers 401.",
      },
      server3Label: {
        type: "string",
        title: "Server 3: label",
        description: "Shown in the panel.",
        default: "M5U",
      },
      server3MetricsUrl: {
        type: "string",
        title: "Server 3: metrics URL",
        description:
          "The M5U (oMLX on a Mac Studio): its /admin/api/activity route. Save it empty to hide this server.",
        default: "http://127.0.0.1:18083/admin/api/activity",
      },
      server3Token: {
        format: "secret-ref",
        title: "Server 3: token",
        description:
          "The M5U's oMLX main API key: pick the Paperclip secret that the M5U AI connection uses, or press + to store it. A sub-key answers 401 on the activity route.",
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
