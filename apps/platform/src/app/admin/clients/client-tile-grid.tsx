"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The client tiles, behaving as an accordion.
 *
 * The exclusivity itself is the `name` attribute on each tile's <details>:
 * opening one closes the other, natively. This wrapper adds the two things the
 * attribute does not do.
 *
 * The first is keeping the tile you opened on screen. Closing the previous tile
 * collapses a block that can be a full screen tall, so when it sat above the one
 * you clicked, the page shifts up under you and the new tile's header ends up
 * above the viewport with only the bottom of its analytics showing. Scrolling
 * the header into view with `nearest` is a no-op when it is already visible, so
 * opening the only open tile never moves the page.
 *
 * The second is a fallback for a browser without `name` grouping, where
 * several tiles would otherwise stay open.
 *
 * `toggle` does not bubble, hence listening in the capture phase on the grid.
 */
export function ClientTileGrid({ children }: { children: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    function onToggle(event: Event) {
      const tile = event.target;
      if (!(tile instanceof HTMLDetailsElement) || !tile.open) return;

      for (const other of grid!.querySelectorAll<HTMLDetailsElement>("details.client-tile[open]")) {
        if (other !== tile) other.open = false;
      }
      tile.querySelector("summary")?.scrollIntoView({ block: "nearest" });
    }

    grid.addEventListener("toggle", onToggle, true);
    return () => grid.removeEventListener("toggle", onToggle, true);
  }, []);

  return (
    <div ref={gridRef} className="client-tile-grid">
      {children}
    </div>
  );
}
