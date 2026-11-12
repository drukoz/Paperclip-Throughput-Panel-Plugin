/**
 * Entry point of the screenshot harness (RUK-1412): renders the real
 * `ThroughputPanel` into the host-shaped overlay container of
 * `harness.html`. `?collapsed=1` forces the collapsed pill.
 */
import { createRoot } from "react-dom/client";
import { ThroughputPanel } from "../../src/ui/index.tsx";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

const COLLAPSED_KEY = "rukoz.throughput-panel.collapsed";

const collapsed = new URLSearchParams(window.location.search).get("collapsed") === "1";
try {
  // Set before the panel reads it in its `useState` initialiser.
  window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
} catch {
  // A blocked localStorage leaves the panel expanded, which is the default.
}

const root = document.getElementById("root");
if (root === null) throw new Error("harness.html has no #root element");

createRoot(root).render(
  <ThroughputPanel context={{ companyId: "harness" } as PluginWidgetProps["context"]} />,
);
