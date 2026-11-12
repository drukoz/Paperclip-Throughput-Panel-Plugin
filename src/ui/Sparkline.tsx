import type { ReactElement } from "react";
import type { SparklinePoint } from "../types.ts";

export interface SparklineProps {
  points: SparklinePoint[];
  /** Default 200. */
  width?: number;
  /** Default 28. */
  height?: number;
  /** Stroke colour. Default "currentColor". */
  color?: string;
}

/**
 * A 28px-tall glance graphic: a single stroked polyline of generation
 * throughput. Decorative to assistive tech (the numbers carry the data).
 */
export function Sparkline(props: SparklineProps): ReactElement | null {
  const { points, width = 200, height = 28, color = "currentColor" } = props;
  if (points.length < 2) return null;

  const inset = 2;
  const innerHeight = height - inset * 2;
  const values = points.map((p) => p.tokensPerSec);
  const max = Math.max(...values);
  const n = values.length;

  const coords = values.map((v, i) => {
    const x = (i / (n - 1)) * width;
    // Y is inverted (SVG origin is top-left); max maps to the top inset,
    // 0 maps to the bottom inset. Flat along the bottom when max <= 0.
    const y = max <= 0 ? height - inset : inset + (1 - v / max) * innerHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
