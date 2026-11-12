import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type {
  ServersSnapshot,
  ServerSnapshot,
  ThroughputSnapshot,
} from "../types.ts";
import { ServerStatus } from "../types.ts";
import type { AverageWindowKey } from "../windows.ts";
import { AVERAGE_WINDOW_KEYS, AVERAGE_WINDOW_MS, isAverageWindowKey } from "../windows.ts";
import { Sparkline } from "./Sparkline.tsx";
import { formatAge, formatCount, formatPct, formatRate } from "./format.ts";
import { averageTitle, pointsInWindow, windowCaption } from "./window.ts";
import {
  HEALTH_STYLE,
  PanelHealth,
  formatTtft,
  kindLabel,
  panelHealth,
  totalGeneration,
} from "./servers-view.ts";
import { PlanUsageSection } from "./PlanUsageSection.tsx";
import { usePlanUsage } from "./usePlanUsage.ts";
import { useProbeUsage } from "./useProbeUsage.ts";
import { probeAccountView } from "../usage/probe-view.ts";
import type { PanelLayout } from "./layout.ts";
import { panelLayout, tapTargetStyle } from "./layout.ts";
import { useViewport } from "./useMediaQuery.ts";

const COLLAPSED_KEY = "rukoz.throughput-panel.collapsed";
const WINDOW_KEY = "rukoz.throughput-panel.window";
const DEFAULT_WINDOW: AverageWindowKey = "5m";

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const MUTED = "rgba(250,250,250,0.55)";
const CARD_BG = "rgba(24,24,27,0.92)";

const STATUS: Record<
  ServerStatus,
  { color: string; title: string }
> = {
  [ServerStatus.Ok]: { color: "#22c55e", title: "Connected" },
  [ServerStatus.Starting]: { color: "#a1a1aa", title: "Starting…" },
  [ServerStatus.Unreachable]: { color: "#ef4444", title: "Model server unreachable" },
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

function ModelBlock({
  model,
  windowKey,
}: {
  model: ThroughputSnapshot;
  windowKey: AverageWindowKey;
}) {
  return (
    <div>
      <div style={{ color: MUTED }}>{model.modelName ?? "model"}</div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div>
          <span style={{ fontSize: 18, fontWeight: 600 }}>
            {formatRate(model.instant?.generation)}
          </span>
          <span style={{ color: MUTED, marginLeft: 3 }}>tok/s</span>
        </div>
        <span
          style={{ color: MUTED }}
          title={averageTitle(windowKey, model.historySpanMs)}
        >
          {windowKey} avg {formatRate(model.averages[windowKey]?.generation)}
        </span>
      </div>
      <SparklineBlock
        points={pointsInWindow(model.sparkline, AVERAGE_WINDOW_MS[windowKey])}
        caption={windowCaption(windowKey)}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "2px 8px",
          marginTop: 6,
        }}
      >
        <Cell
          label="per req"
          value={formatRate(model.perRequestTokensPerSec[windowKey])}
          unit=" tok/s"
        />
        <Cell label="ttft" value={formatTtft(model.timeToFirstTokenMs[windowKey])} />
        <Cell label="prompt" value={formatRate(model.instant?.prompt)} unit=" tok/s" />
        <Cell label="running" value={formatCount(model.numRequestsRunning)} />
        <Cell label="waiting" value={formatCount(model.numRequestsWaiting)} />
        <Cell label="kv cache" value={formatPct(model.kvCacheUsagePct)} />
        <Cell label="cache hit" value={formatPct(model.prefixCacheHitRatePct)} />
        <Cell label="mtp acc" value={formatPct(model.mtpAcceptanceRatePct)} />
      </div>
    </div>
  );
}

function ServerSection({
  server,
  windowKey,
}: {
  server: ServerSnapshot;
  windowKey: AverageWindowKey;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.12)",
        marginTop: 8,
        paddingTop: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 600, flex: 1 }}>{server.label}</span>
        <span style={{ color: MUTED }}>{kindLabel(server.kind)}</span>
        <StatusDot status={server.status} />
      </div>
      {server.status === ServerStatus.Unreachable ? (
        <>
          {server.error ? <div style={errMsg}>{server.error}</div> : null}
          <div style={{ color: MUTED, fontSize: 10, marginTop: 4 }}>
            last seen {formatAge(server.lastSampleAt)}
          </div>
        </>
      ) : null}
      {server.status === ServerStatus.Ok && server.models.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 10, marginTop: 4 }}>no models reported</div>
      ) : null}
      {server.models.map((model, index) => (
        <div key={model.modelName ?? ""} style={index > 0 ? { marginTop: 8 } : undefined}>
          <ModelBlock model={model} windowKey={windowKey} />
        </div>
      ))}
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
  layout,
}: {
  selected: AverageWindowKey;
  onSelect: (key: AverageWindowKey) => void;
  layout: PanelLayout;
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
          style={{
            ...(key === selected ? windowBtnOn : windowBtn),
            fontSize: layout.windowButtonFontSize,
            padding: layout.windowButtonPadding,
            ...tapTargetStyle(layout.minTarget),
          }}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

/** Per-server `label: <rate> tok/s` lines for the pill tooltip; unreachable servers read "unreachable". */
function serverBreakdown(servers: ServerSnapshot[]): string {
  return servers
    .map((server) => {
      if (server.status === ServerStatus.Unreachable) return `${server.label}: unreachable`;
      let sum = 0;
      for (const model of server.models) {
        if (model.instant !== null) sum += model.instant.generation;
      }
      return `${server.label}: ${formatRate(sum)} tok/s`;
    })
    .join(" · ");
}

export function ThroughputPanel({ context }: PluginWidgetProps) {
  const { data, error, refresh } = usePluginData<ServersSnapshot>("servers", { companyId: context.companyId });

  useEffect(() => {
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const layout = panelLayout(useViewport());

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

  // Rich card only when at least one server has reported; otherwise a compact pill.
  const health = data === null ? PanelHealth.Starting : panelHealth(data.servers);
  const hasRichData =
    error === null && data !== null && health !== PanelHealth.Starting;
  const showCompact = collapsed || !hasRichData;
  // Claude usage is checked only while the card is expanded. With Claude accounts in the
  // plugin settings the worker checks each one (useProbeUsage, RUK-518); otherwise, or while
  // an older worker without that handler runs, the default subscription (usePlanUsage, RUK-249).
  const probe = useProbeUsage(!showCompact, context.companyId);
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
            layout={layout}
          />
        );
      })
    ) : (
      <PlanUsageSection view={planUsage.view} onRefresh={planUsage.refresh} layout={layout} />
    );

  let compact: { color: string; title: string; text: string; message?: string };
  if (error !== null) {
    compact = {
      color: STATUS[ServerStatus.Unreachable].color,
      title: "Panel unavailable",
      text: "Panel unavailable",
      message: error.message,
    };
  } else if (data === null) {
    compact = { color: HEALTH_STYLE[PanelHealth.Starting].color, title: "Starting…", text: "…" };
  } else if (health === PanelHealth.Starting) {
    compact = { color: HEALTH_STYLE[PanelHealth.Starting].color, title: "Starting…", text: "Starting…" };
  } else if (health === PanelHealth.Down) {
    const style = HEALTH_STYLE[PanelHealth.Down];
    compact = { color: style.color, title: style.title, text: "—" };
  } else {
    compact = {
      color: HEALTH_STYLE[health].color,
      title: serverBreakdown(data.servers),
      text: `${formatRate(totalGeneration(data.servers))} tok/s`,
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
    // Paperclip's overlay container places us: 16px from the corner on desktop, above its bottom nav on phones.
    <div style={{ pointerEvents: "none" }}>
      {showCompact ? (
        hasRichData ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={false}
            aria-label="Expand throughput panel"
            style={{
              ...pillCard,
              cursor: "pointer",
              ...(layout.minTarget > 0
                ? { minHeight: layout.minTarget, justifyContent: "center" }
                : {}),
            }}
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
            aria-label="Model throughput"
            style={{
              ...baseCard,
              width: 232,
              padding: "8px 10px",
              maxHeight: layout.cardMaxHeight,
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
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
              <span
                title={HEALTH_STYLE[health].title}
                style={dotStyle(HEALTH_STYLE[health].color)}
              />
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={true}
                aria-label="Collapse throughput panel"
                style={{ ...collapseBtn, ...tapTargetStyle(layout.minTarget) }}
              >
                –
              </button>
            </div>

            <WindowSelector selected={windowKey} onSelect={selectWindow} layout={layout} />
            {data.servers.map((server) => (
              <ServerSection key={server.slot} server={server} windowKey={windowKey} />
            ))}
            {claudeSections}
          </div>
        )
      )}
    </div>
  );
}
