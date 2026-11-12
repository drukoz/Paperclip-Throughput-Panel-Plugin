/**
 * Screenshot harness for the mobile work (RUK-1412): bundles the real panel
 * with the SDK stub, loads `harness.html` in headless Chrome, and writes four
 * PNGs to `out/` — phone (touch) and desktop, expanded and collapsed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out");
const page = `file://${resolve(here, "harness.html")}`;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** A blank 390x844 PNG is well over this, so a smaller file means a broken shot. */
const MIN_BYTES = 5_000;
/** Makes `(pointer: coarse)` match, i.e. a touch screen (measured on this Mac). */
const TOUCH_FLAGS = [
  "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, "harness.tsx")],
  outfile: resolve(outDir, "harness.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@paperclipai/plugin-sdk/ui": resolve(here, "sdk-stub.ts") },
  define: { "process.env.NODE_ENV": '"production"' },
});

const shots = [
  { file: "phone-expanded.png", window: "390,844", touch: true, collapsed: false },
  { file: "phone-collapsed.png", window: "390,844", touch: true, collapsed: true },
  { file: "desktop-expanded.png", window: "1280,800", touch: false, collapsed: false },
  { file: "desktop-collapsed.png", window: "1280,800", touch: false, collapsed: true },
];

let failed = false;
for (const shot of shots) {
  const target = resolve(outDir, shot.file);
  // A fresh profile per shot, so localStorage from a collapsed shot cannot leak.
  const profile = mkdtempSync(resolve(tmpdir(), "mobile-harness-"));
  const chromeArgs = [
    chrome,
    "--headless=new",
    "--use-mock-keychain",
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--hide-scrollbars",
    ...(shot.touch ? TOUCH_FLAGS : []),
    "--virtual-time-budget=3000",
    `--window-size=${shot.window}`,
    `--screenshot=${target}`,
    shot.collapsed ? `${page}?collapsed=1` : page,
  ];
  try {
    // No `timeout` on this Mac: perl's alarm fires inside the exec'd Chrome.
    execFileSync("perl", ["-e", "alarm shift; exec @ARGV", "60", ...chromeArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(`${shot.file}: chrome failed: ${err.shortMessage ?? err.message}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const bytes = existsSync(target) ? statSync(target).size : 0;
  const ok = bytes >= MIN_BYTES;
  failed ||= !ok;
  console.log(`${shot.file}: ${bytes} bytes${ok ? "" : " — MISSING OR TOO SMALL"}`);
}
process.exit(failed ? 1 : 0);
