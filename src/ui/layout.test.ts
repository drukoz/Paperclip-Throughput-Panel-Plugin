import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COARSE_QUERY,
  NARROW_QUERY,
  TOUCH_TARGET_PX,
  panelLayout,
  tapTargetStyle,
} from "./layout.ts";

const PHONE_HEIGHT =
  "calc(100dvh - var(--plugin-shell-mobile-bottom, 96px) - 16px - env(safe-area-inset-top, 0px))";

test("panelLayout keeps today's desktop values when neither flag is set", () => {
  assert.deepEqual(panelLayout({ narrow: false, coarse: false }), {
    cardMaxHeight: "calc(100dvh - 32px)",
    minTarget: 0,
    windowButtonFontSize: 10,
    windowButtonPadding: "1px 6px",
    tapForDetails: false,
  });
});

test("panelLayout gives a phone the phone height and the touch button sizes", () => {
  assert.deepEqual(panelLayout({ narrow: true, coarse: true }), {
    cardMaxHeight: PHONE_HEIGHT,
    minTarget: 36,
    windowButtonFontSize: 12,
    windowButtonPadding: "6px 12px",
    tapForDetails: true,
  });
});

test("panelLayout on a narrow mouse window takes the phone height with desktop buttons", () => {
  assert.deepEqual(panelLayout({ narrow: true, coarse: false }), {
    cardMaxHeight: PHONE_HEIGHT,
    minTarget: 0,
    windowButtonFontSize: 10,
    windowButtonPadding: "1px 6px",
    tapForDetails: false,
  });
});

test("panelLayout on a wide touch screen takes the desktop height with touch button sizes", () => {
  assert.deepEqual(panelLayout({ narrow: false, coarse: true }), {
    cardMaxHeight: "calc(100dvh - 32px)",
    minTarget: 36,
    windowButtonFontSize: 12,
    windowButtonPadding: "6px 12px",
    tapForDetails: true,
  });
});

test("the phone card height clears Paperclip's bottom nav", () => {
  const { cardMaxHeight } = panelLayout({ narrow: true, coarse: false });
  assert.ok(cardMaxHeight.includes("var(--plugin-shell-mobile-bottom"));
});

test("tapTargetStyle is empty on desktop so buttons keep their size", () => {
  assert.deepEqual(tapTargetStyle(0), {});
});

test("tapTargetStyle enforces the touch target with centred content", () => {
  assert.deepEqual(tapTargetStyle(36), {
    minWidth: 36,
    minHeight: 36,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  });
});

test("the media queries and the touch target are Paperclip's and the spec's", () => {
  assert.equal(NARROW_QUERY, "(max-width: 767px)");
  assert.equal(COARSE_QUERY, "(pointer: coarse)");
  assert.equal(TOUCH_TARGET_PX, 36);
});
