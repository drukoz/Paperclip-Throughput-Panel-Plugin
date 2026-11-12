import { useEffect, useState } from "react";
import type { Viewport } from "./layout.ts";
import { COARSE_QUERY, NARROW_QUERY } from "./layout.ts";

/** Whether `query` matches now; false where matchMedia is missing. */
function matchesNow(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  } catch {
    return false;
  }
}

/** Live result of a CSS media query; re-renders when it starts or stops matching (rotation, resize). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => matchesNow(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange(); // the query may have changed since the first render
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The panel's current Viewport (phone width, touch screen). */
export function useViewport(): Viewport {
  return { narrow: useMediaQuery(NARROW_QUERY), coarse: useMediaQuery(COARSE_QUERY) };
}
