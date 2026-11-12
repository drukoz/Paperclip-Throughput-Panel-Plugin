import type { CSSProperties } from "react";

/** Paperclip's phone breakpoint: at this width the host shows its bottom nav and lifts plugin overlays above it. */
export const NARROW_QUERY = "(max-width: 767px)";

/** A touch screen is the primary pointer. */
export const COARSE_QUERY = "(pointer: coarse)";

/** Smallest tap target on a touch screen, in CSS px. */
export const TOUCH_TARGET_PX = 36;

// The phone height subtracts the host's bottom nav offset and the top safe
// area, so the expanded card sits fully on screen next to the nav bar.
const DESKTOP_CARD_MAX_HEIGHT = "calc(100dvh - 32px)";
const PHONE_CARD_MAX_HEIGHT =
  "calc(100dvh - var(--plugin-shell-mobile-bottom, 96px) - 16px - env(safe-area-inset-top, 0px))";

/** What kind of screen the panel is on. */
export interface Viewport {
  /** Matches NARROW_QUERY. */
  narrow: boolean;
  /** Matches COARSE_QUERY. */
  coarse: boolean;
}

/** Sizes the panel uses for one Viewport. */
export interface PanelLayout {
  /** CSS max-height of the expanded card. */
  cardMaxHeight: string;
  /** Minimum width and height of every panel button, in px; 0 means no minimum. */
  minTarget: number;
  /** Font size of the 1m/5m/15m buttons, in px. */
  windowButtonFontSize: number;
  /** CSS padding of the 1m/5m/15m buttons. */
  windowButtonPadding: string;
  /** True when the Claude meter rows should open their details on tap (a touch screen has no hover tooltips). */
  tapForDetails: boolean;
}

/** The panel's sizes for a viewport; desktop values when neither flag is set. */
export function panelLayout(viewport: Viewport): PanelLayout {
  return {
    cardMaxHeight: viewport.narrow ? PHONE_CARD_MAX_HEIGHT : DESKTOP_CARD_MAX_HEIGHT,
    minTarget: viewport.coarse ? TOUCH_TARGET_PX : 0,
    windowButtonFontSize: viewport.coarse ? 12 : 10,
    windowButtonPadding: viewport.coarse ? "6px 12px" : "1px 6px",
    tapForDetails: viewport.coarse,
  };
}

/**
 * Style that makes a button at least `minTarget` px wide and tall, its content centred;
 * an empty object when `minTarget` is 0 or less, so desktop buttons keep their size.
 */
export function tapTargetStyle(minTarget: number): CSSProperties {
  return minTarget > 0
    ? {
        minWidth: minTarget,
        minHeight: minTarget,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }
    : {};
}
