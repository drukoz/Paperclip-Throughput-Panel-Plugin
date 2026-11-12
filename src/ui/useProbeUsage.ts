import { useEffect } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PlanProbeSnapshot } from "../usage/probe-types.ts";

/** How often the expanded panel asks the worker for the accounts' state. */
export const PROBE_POLL_MS = 30_000;

export interface ProbeUsageHandle {
  /** The worker's last answer, or null before the first one or when the call failed. */
  snapshot: PlanProbeSnapshot | null;
  /** True when the last call to the worker failed, for example while an older worker without the "plan-probe" handler still runs. */
  failed: boolean;
  /** Asks the worker again now. */
  refresh: () => void;
}

/**
 * The worker's per-account Claude check state. While `active` (the card is
 * expanded) it asks every PROBE_POLL_MS with `active: true`, and the worker
 * starts any check that is due; otherwise it only reads, so a collapsed panel
 * spends no Claude usage.
 */
export function useProbeUsage(active: boolean, companyId: string | null): ProbeUsageHandle {
  const { data, error, refresh } = usePluginData<PlanProbeSnapshot>("plan-probe", { active, companyId });

  useEffect(() => {
    if (!active) return;
    // A hidden tab asks nothing, so it starts no check.
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, PROBE_POLL_MS);
    return () => clearInterval(id);
  }, [active, refresh]);

  return { snapshot: error === null ? data : null, failed: error !== null, refresh };
}
