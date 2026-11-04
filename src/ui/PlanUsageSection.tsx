import type { CSSProperties, ReactElement } from "react";
import type { PlanUsageRow, PlanUsageView } from "../usage/types.ts";
import { formatAge, formatPct, isWindowRestarted, meterDetails, usageColor } from "./format.ts";

const MUTED = "rgba(250,250,250,0.55)";

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

function MeterRow({
  label,
  row,
  now,
}: {
  label: string;
  row: PlanUsageRow | null;
  now?: number;
}) {
  const ref = now ?? Date.now();
  const shown = row !== null && !isWindowRestarted(row.resetsAt, ref) ? row : null;
  const details = meterDetails(label, row, ref);
  return (
    // Screen readers ignore aria-label on a role-less div; "img" makes them
    // read the full sentence, reset time included, instead of the bare cells.
    <div
      role="img"
      style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}
      title={details}
      aria-label={details}
    >
      <span style={{ color: MUTED, width: 72, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: "rgba(255,255,255,0.12)",
          overflow: "hidden",
        }}
      >
        {shown ? (
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${Math.min(100, Math.max(0, shown.usedPercent))}%`,
              background: usageColor(shown.usedPercent),
            }}
          />
        ) : null}
      </span>
      <span style={{ width: 34, textAlign: "right" }}>
        {shown ? formatPct(shown.usedPercent) : "—"}
      </span>
    </div>
  );
}

/**
 * The panel's "Claude plan" section: the 5-hour session, weekly and Fable
 * weekly meters, or the reason they are missing. Presentational only.
 * `heading` replaces the "Claude plan" title (one section per checked account);
 * `showFable: false` hides the Fable row.
 */
export function PlanUsageSection(props: {
  view: PlanUsageView;
  onRefresh?: () => void;
  now?: number;
  heading?: string;
  showFable?: boolean;
}): ReactElement {
  const { view, onRefresh, now } = props;
  const heading = props.heading ?? "Claude plan";
  const accountLabel =
    view.kind === "ok" || view.kind === "needs_attention"
      ? view.accountLabel
      : undefined;
  return (
    <div
      role="group"
      aria-label={`${heading} usage`}
      style={{
        marginTop: 8,
        paddingTop: 6,
        borderTop: "1px solid rgba(255,255,255,0.10)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 600, flex: 1 }} title={accountLabel}>
          {heading}
        </span>
        {view.kind === "loading" ? (
          <span style={{ color: MUTED }}>checking…</span>
        ) : view.kind === "ok" ? (
          <span style={{ color: MUTED }}>{formatAge(view.checkedAt, now)}</span>
        ) : null}
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh Claude usage"
            title="Refresh Claude usage"
            style={{ ...collapseBtn, fontSize: 12 }}
          >
            ↻
          </button>
        ) : null}
      </div>
      {view.kind === "ok" ? (
        <>
          <MeterRow label="5h session" row={view.usage.session} now={now} />
          <MeterRow label="Weekly" row={view.usage.weekly} now={now} />
          {props.showFable !== false ? (
            <MeterRow label="Fable weekly" row={view.usage.fable} now={now} />
          ) : null}
          {view.refreshError !== null ? (
            <div style={errMsg}>{view.refreshError}</div>
          ) : null}
        </>
      ) : view.kind === "no_connection" ? (
        <div style={errMsg}>No Claude subscription connected</div>
      ) : view.kind === "needs_attention" ? (
        <div style={errMsg}>{view.message}</div>
      ) : view.kind === "error" ? (
        <div style={errMsg}>{`Usage unavailable: ${view.message}`}</div>
      ) : null}
    </div>
  );
}
