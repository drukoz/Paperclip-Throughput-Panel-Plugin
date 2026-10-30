import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlanUsage } from "../usage/client.ts";
import type { PlanUsageResult, PlanUsageView } from "../usage/types.ts";
import {
  PLAN_USAGE_MANUAL_GAP_MS,
  PLAN_USAGE_MIN_GAP_MS,
  PLAN_USAGE_POLL_MS,
  nextPlanUsageDelayMs,
  reducePlanUsageView,
} from "../usage/view.ts";

export interface PlanUsageHandle {
  view: PlanUsageView;
  /** Check now, unless the last check was under 10 s ago. */
  refresh: () => void;
}

/** Polls Claude plan usage for `companyId` while `enabled` is true. */
export function usePlanUsage(companyId: string | null, enabled: boolean): PlanUsageHandle {
  const [view, setView] = useState<PlanUsageView>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const lastCheckAt = useRef(0);

  useEffect(() => {
    if (!enabled || companyId === null) return;
    const id = companyId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(() => void run(), ms);
    };

    async function run(): Promise<void> {
      timer = null;
      if (document.visibilityState === "hidden") {
        schedule(PLAN_USAGE_POLL_MS);
        return;
      }
      controller = new AbortController();
      lastCheckAt.current = Date.now();
      let result: PlanUsageResult;
      try {
        result = await fetchPlanUsage(id, { signal: controller.signal });
      } catch {
        return;
      }
      if (cancelled) return;
      setView((previous) => reducePlanUsageView(previous, result));
      schedule(nextPlanUsageDelayMs(result));
    }

    const since = Date.now() - lastCheckAt.current;
    schedule(since >= PLAN_USAGE_MIN_GAP_MS ? 0 : PLAN_USAGE_MIN_GAP_MS - since);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    };
  }, [companyId, enabled, nonce]);

  const refresh = useCallback(() => {
    if (Date.now() - lastCheckAt.current < PLAN_USAGE_MANUAL_GAP_MS) return;
    lastCheckAt.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return { view, refresh };
}
