import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPlanUsage } from "../usage/client.ts";
import { fetchRunPlanUsage } from "../usage/run-client.ts";
import type { RunLogMemo } from "../usage/run-client.ts";
import {
  applyCheckResult,
  isCheckDue,
  loadStoredPlanUsage,
  manualCheckAllowed,
  saveStoredPlanUsage,
} from "../usage/stored.ts";
import type { KeyValueStorage } from "../usage/stored.ts";
import { PLAN_USAGE_MANUAL_GAP_MS, buildPlanUsageView, newerReading } from "../usage/view.ts";
import type {
  PlanUsageReading,
  PlanUsageResult,
  PlanUsageView,
  StoredPlanUsage,
} from "../usage/types.ts";

export interface PlanUsageHandle {
  view: PlanUsageView;
  /** Check now, unless the last check was under 10 s ago. */
  refresh: () => void;
}

/** Gap between reads of the agent-run logs while the card is expanded. */
export const PLAN_USAGE_RUN_POLL_MS = 60_000;
/** How long one tab's claim on a due usage check keeps other tabs from starting their own. */
export const PLAN_USAGE_CLAIM_MS = 60_000;

/** The browser's localStorage, or null where reading it throws. */
function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Shows Claude plan usage for `companyId` while `enabled` is true: the meters from
 * agent runs, re-read every minute, plus Anthropic's usage check run only when due,
 * with the check schedule shared through localStorage so reloads and other tabs reuse it.
 */
export function usePlanUsage(companyId: string | null, enabled: boolean): PlanUsageHandle {
  const [runs, setRuns] = useState<PlanUsageReading | null>(null);
  const [stored, setStored] = useState<StoredPlanUsage | null>(null);
  const memo = useRef<RunLogMemo>(new Map());
  // Set by refresh to run a usage check now, bypassing the stored schedule once.
  const forceCheck = useRef(false);
  const lastPress = useRef(0);
  // Bumping either nonce restarts its poller, so refresh reads the runs and checks at once.
  const [runNonce, setRunNonce] = useState(0);
  const [checkNonce, setCheckNonce] = useState(0);

  const view = useMemo(() => buildPlanUsageView(runs, stored), [runs, stored]);

  // On a company change, drop the previous company's reads and show its last stored check at once.
  useEffect(() => {
    memo.current = new Map();
    setRuns(null);
    setStored(companyId === null ? null : loadStoredPlanUsage(browserStorage(), companyId));
  }, [companyId]);

  // Read the agent-run logs at once, then every minute, while the card is expanded.
  useEffect(() => {
    if (!enabled || companyId === null) return;
    const id = companyId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(() => void tick(), ms);
    };

    async function tick(): Promise<void> {
      timer = null;
      // A hidden tab spends no requests, but keeps its heartbeat so showing it reads again at once.
      if (document.visibilityState !== "hidden") {
        controller = new AbortController();
        let reading: PlanUsageReading | null;
        try {
          reading = await fetchRunPlanUsage(id, { signal: controller.signal, memo: memo.current });
        } catch {
          // Aborted when the effect was cleaned up; the next effect owns the schedule now.
          return;
        }
        if (cancelled) return;
        if (reading !== null) {
          const observed = reading;
          setRuns((previous) => newerReading(previous, observed));
        }
      }
      schedule(PLAN_USAGE_RUN_POLL_MS);
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    };
  }, [companyId, enabled, runNonce]);

  // Run Anthropic's usage check only when due, sharing the schedule through localStorage.
  useEffect(() => {
    if (!enabled || companyId === null) return;
    const id = companyId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    // Set when a check came due while the tab was hidden, so showing the tab runs it at once.
    let waitingForVisible = false;

    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(() => void tick(), ms);
    };

    async function tick(): Promise<void> {
      timer = null;
      const storage = browserStorage();
      const current = loadStoredPlanUsage(storage, id);
      const now = Date.now();
      // Not due: another tab may have run the check, so show its result and wait for the next due time.
      if (!forceCheck.current && current !== null && !isCheckDue(current, now)) {
        setStored(current);
        schedule(Math.max(1_000, current.nextCheckAt - now));
        return;
      }
      if (document.visibilityState === "hidden") {
        waitingForVisible = true;
        return;
      }
      // Claim the check by recording a recent attempt, so other tabs see it and hold off.
      saveStoredPlanUsage(storage, id, {
        lastAttemptAt: now,
        nextCheckAt: now + PLAN_USAGE_CLAIM_MS,
        good: current?.good ?? null,
        accountLabel: current?.accountLabel ?? null,
        last: current?.last ?? null,
      });
      waitingForVisible = false;
      forceCheck.current = false;
      controller = new AbortController();
      let result: PlanUsageResult;
      try {
        result = await fetchPlanUsage(id, { signal: controller.signal });
      } catch {
        // Aborted when the effect was cleaned up.
        return;
      }
      if (cancelled) return;
      const next = applyCheckResult(current, result, Date.now());
      saveStoredPlanUsage(storage, id, next);
      setStored(next);
      schedule(Math.max(1_000, next.nextCheckAt - Date.now()));
    }

    const onVisibilityChange = () => {
      if (!waitingForVisible || document.visibilityState === "hidden") return;
      void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    void tick();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    };
  }, [companyId, enabled, checkNonce]);

  const refresh = useCallback(() => {
    const now = Date.now();
    if (now - lastPress.current < PLAN_USAGE_MANUAL_GAP_MS) return;
    lastPress.current = now;
    setRunNonce((n) => n + 1);
    // A forced usage check only when the last attempt is old enough, so the button cannot hammer Anthropic.
    if (companyId !== null && manualCheckAllowed(loadStoredPlanUsage(browserStorage(), companyId), Date.now())) {
      forceCheck.current = true;
      setCheckNonce((n) => n + 1);
    }
  }, [companyId]);

  return { view, refresh };
}
