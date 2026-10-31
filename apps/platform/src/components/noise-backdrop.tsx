"use client";

import { useEffect, useRef } from "react";
import { backdropAttributes, type BackdropTone } from "./noise-backdrop-settings";

/**
 * A faint, slowly moving blue field behind the whole page.
 *
 * The server renders only the empty host; the element and its WebGL canvas
 * are created here, after hydration, from a module loaded on demand, so
 * nothing about it runs on the server or delays the first paint. The element
 * handles the rest itself: one still frame under `prefers-reduced-motion`,
 * paused while the tab is hidden, and the plain ground where WebGL is missing.
 *
 * Decorative only, and behind everything: the panes and their text sit on
 * their own opaque faces, so no contrast on the page changes.
 */
export function NoiseBackdrop({ tone = "auto" }: { tone?: BackdropTone }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    let element: HTMLElement | null = null;
    let cancelled = false;

    const apply = () => {
      if (!element) return;
      for (const [name, value] of Object.entries(backdropAttributes(tone, dark.matches))) {
        element.setAttribute(name, value);
      }
    };

    import("@/lib/noise-backdrop/noise-backdrop.js")
      .then(() => {
        if (cancelled) return;
        element = document.createElement("noise-backdrop");
        apply();
        host.append(element);
      })
      // The page is whole without it; say why it is missing and carry on.
      .catch((error: unknown) => console.warn("noise-backdrop: not loaded, showing the plain ground.", error));

    dark.addEventListener("change", apply);
    return () => {
      cancelled = true;
      dark.removeEventListener("change", apply);
      element?.remove();
    };
  }, [tone]);

  return <div ref={hostRef} className="noise-backdrop" aria-hidden="true" />;
}
