import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { ThroughputSnapshot } from "../types.ts";
import type { AverageWindowKey } from "../windows.ts";
import { AVERAGE_WINDOW_KEYS, AVERAGE_WINDOW_MS, isAverageWindowKey } from "../windows.ts";
import { Sparkline } from "./Sparkline.tsx";
import { formatAge, formatCount, formatPct, formatRate } from "./format.ts";
import { averageTitle, pointsInWindow, windowCaption } from "./window.ts";
import { PlanUsageSection } from "./PlanUsageSection.tsx";
import { usePlanUsage } from "./usePlanUsage.ts";
import { useProbeUsage } from "./useProbeUsage.ts";
import { probeAccountView } from "../usage/probe-view.ts";

const COLLAPSED_KEY = "rukoz.throughput-panel.collapsed";
const WINDOW_KEY = "rukoz.throughput-panel.window";
const DEFAULT_WINDOW: AverageWindowKey = "5m";

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const MUTED = "rgba(250,250,250,0.55)";
const CARD_BG = "rgba(24,24,27,0.92)";

const STATUS: Record<
  ThroughputSnapshot["status"],
  { color: string; title: string }
> = {
  ok: { color: "#22c55e", title: "Connected" },
  starting: { color: "#a1a1aa", title: "Starting…" },
  unreachable: { color: "#ef4444", title: "Model server unreachable" },
};

const baseCard: CSSProperties = {
  background: CARD_BG,
  color: "#fafafa",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(6px)",
  borderRadius: 10,
  fontSize: 11,
  lineHeight: 1.35,
  fontFamily: FONT_STACK,
  fontVariantNumeric: "tabular-nums",
  boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
  pointerEvents: "auto",
};

const pillCard: CSSProperties = {
  ...baseCard,
  minWidth: 92,
  maxWidth: 220,
  padding: "6px 10px",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
};

const collapseBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: MUTED,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 2,
  margin: 0,
  borderRadius: 4,
};

const windowBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 5,
  color: MUTED,
  cursor: "pointer",
  fontFamily: FONT_STACK,
  fontSize: 10,
  lineHeight: 1.2,
  padding: "1px 6px",
  margin: 0,
};

const windowBtnOn: CSSProperties = {
  ...windowBtn,
  background: "rgba(255,255,255,0.14)",
  borderColor: "rgba(255,255,255,0.28)",
  color: "#fafafa",
};

const errMsg: CSSProperties = {
  color: MUTED,
  fontSize: 10,
  marginTop: 4,
  wordBreak: "break-word",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

function dotStyle(color: string): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
    flexShrink: 0,
  };
}

function StatusDot({ status }: { status: ThroughputSnapshot["status"] }) {
  const s = STATUS[status];
  return <span title={s.title} style={dotStyle(s.color)} />;
}

function Cell({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
      <span style={{ color: MUTED, flexShrink: 0 }}>{label}</span>
      <span style={{ marginInlineStart: "auto" }}>
        {value}
        {unit ? <span style={{ color: MUTED }}>{unit}</span> : null}
      </span>
    </div>
  );
}

function StatGrid({ data }: { data: ThroughputSnapshot }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "2px 8px",
        marginTop: 6,
      }}
    >
      <Cell label="prompt" value={formatRate(data.instant?.prompt)} unit=" tok/s" />
      <Cell label="running" value={formatCount(data.numRequestsRunning)} />
      <Cell label="waiting" value={formatCount(data.numRequestsWaiting)} />
      <Cell label="kv cache" value={formatPct(data.kvCacheUsagePct)} />
      <Cell label="cache hit" value={formatPct(data.prefixCacheHitRatePct)} />
      <Cell label="mtp acc" value={formatPct(data.mtpAcceptanceRatePct)} />
    </div>
  );
}

function SparklineBlock({
  points,
  caption,
}: {
  points: ThroughputSnapshot["sparkline"];
  caption: string;
}) {
  if (points.length < 2) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <Sparkline points={points} width={212} />
      <div style={{ color: MUTED, fontSize: 10, marginTop: 2 }}>{caption}</div>
    </div>
  );
}

function WindowSelector({
  selected,
  onSelect,
}: {
  selected: AverageWindowKey;
  onSelect: (key: AverageWindowKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Average window"
      style={{ display: "flex", gap: 4, marginTop: 6 }}
    >
      {AVERAGE_WINDOW_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          aria-pressed={key === selected}
          style={key === selected ? windowBtnOn : windowBtn}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

export function ThroughputPanel({ context }: PluginWidgetProps) {
  const { data, error, refresh } = usePluginData<ThroughputSnapshot>("throughput");

  useEffect(() => {
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [windowKey, setWindowKey] = useState<AverageWindowKey>(() => {
    try {
      const stored = window.localStorage.getItem(WINDOW_KEY);
      return isAverageWindowKey(stored) ? stored : DEFAULT_WINDOW;
    } catch {
      return DEFAULT_WINDOW;
    }
  });

  function selectWindow(key: AverageWindowKey) {
    setWindowKey(key);
    try {
      window.localStorage.setItem(WINDOW_KEY, key);
    } catch {
      // localStorage can throw in locked-down contexts; the selection still applies in-memory.
    }
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage can throw in locked-down contexts; the panel still toggles in-memory.
      }
      return next;
    });
  }

  // Rich card only when we have a real snapshot; otherwise a compact pill.
  const hasRichData =
    error === null &&
    data !== null &&
    (data.status === "ok" || data.status === "unreachable");
  const showCompact = collapsed || !hasRichData;
  // Claude usage is checked only while the card is expanded. With Claude accounts in the
  // plugin settings the worker checks each one (useProbeUsage, RUK-518); otherwise, or while
  // an older worker without that handler runs, the default subscription (usePlanUsage, RUK-249).
  const probe = useProbeUsage(!showCompact);
  const probeAccounts = probe.snapshot?.accounts ?? [];
  const useDefaultSubscription = probe.failed || (probe.snapshot !== null && probeAccounts.length === 0);
  const planUsage = usePlanUsage(context.companyId, !showCompact && useDefaultSubscription);
  const claudeSections =
    probeAccounts.length > 0 ? (
      probeAccounts.map((account, index) => {
        const view = probeAccountView(account);
        return (
          <PlanUsageSection
            key={`${index}:${account.label}`}
            heading={`Claude · ${account.label}`}
            view={view}
            onRefresh={probe.refresh}
            showFable={view.kind === "ok" && view.usage.fable !== null}
          />
        );
      })
    ) : (
      <PlanUsageSection view={planUsage.view} onRefresh={planUsage.refresh} />
    );

  let compact: { color: string; title: string; text: string; message?: string };
  if (error !== null) {
    compact = {
      color: STATUS.unreachable.color,
      title: "Panel unavailable",
      text: "Panel unavailable",
      message: error.message,
    };
  } else if (data === null) {
    compact = { color: STATUS.starting.color, title: "Starting…", text: "…" };
  } else if (data.status === "starting") {
    compact = { color: STATUS.starting.color, title: "Starting…", text: "Starting…" };
  } else if (data.status === "unreachable") {
    compact = { color: STATUS.unreachable.color, title: "Model server unreachable", text: "—" };
  } else {
    compact = {
      color: STATUS.ok.color,
      title: "Connected",
      text: `${formatRate(data.instant?.generation)} tok/s`,
    };
  }

  const pillBody = (
    <>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span title={compact.title} style={dotStyle(compact.color)} />
        <span>{compact.text}</span>
      </span>
      {compact.message ? (
        <span style={{ ...errMsg, marginTop: 0 }}>{compact.message}</span>
      ) : null}
    </>
  );

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 40,
        pointerEvents: "none",
      }}
    >
      {showCompact ? (
        hasRichData ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={false}
            aria-label="Expand throughput panel"
            style={{ ...pillCard, cursor: "pointer" }}
          >
            {pillBody}
          </button>
        ) : (
          // Starting / loading / bridge error: the pill is the whole readout,
          // there is nothing to expand into. A button here would claim to
          // expand, do nothing visible, and silently persist `collapsed` —
          // so the panel would come back collapsed once data arrived.
          <div role="status" aria-live="polite" style={pillCard}>
            {pillBody}
          </div>
        )
      ) : (
        data && (
          <div
            role="status"
            aria-live="polite"
            aria-label={data.modelName ?? "Model throughput"}
            style={{ ...baseCard, width: 232, padding: "8px 10px" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 600, flex: 1 }}>Model throughput</span>
              <StatusDot status={data.status} />
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={true}
                aria-label="Collapse throughput panel"
                style={collapseBtn}
              >
                –
              </button>
            </div>

            {data.status === "ok" ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                  }}
                >
                  <div>
                    <span style={{ fontSize: 18, fontWeight: 600 }}>
                      {formatRate(data.instant?.generation)}
                    </span>
                    <span style={{ color: MUTED, marginLeft: 3 }}>tok/s</span>
                  </div>
                  <span
                    style={{ color: MUTED }}
                    title={averageTitle(windowKey, data.historySpanMs)}
                  >
                    {windowKey} avg {formatRate(data.averages[windowKey]?.generation)}
                  </span>
                </div>
                <WindowSelector selected={windowKey} onSelect={selectWindow} />
                <SparklineBlock
                  points={pointsInWindow(data.sparkline, AVERAGE_WINDOW_MS[windowKey])}
                  caption={windowCaption(windowKey)}
                />
                <StatGrid data={data} />
                <div style={{ color: MUTED, fontSize: 10, marginTop: 6 }}>
                  {data.modelName ?? "—"} · {formatAge(data.lastSampleAt)}
                </div>
                {claudeSections}
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <StatusDot status="unreachable" />
                  <span style={{ fontWeight: 600 }}>Model server unreachable</span>
                </div>
                {data.error ? <div style={errMsg}>{data.error}</div> : null}
                <WindowSelector selected={windowKey} onSelect={selectWindow} />
                <SparklineBlock
                  points={pointsInWindow(data.sparkline, AVERAGE_WINDOW_MS[windowKey])}
                  caption={`${windowCaption(windowKey)} (stale)`}
                />
                <div style={{ color: MUTED, fontSize: 10, marginTop: 6 }}>
                  last seen {formatAge(data.lastSampleAt)}
                </div>
                <StatGrid data={data} />
                {claudeSections}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
