"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A notice that takes focus when it appears.
 *
 * Shown after a removal, where the control that had focus — the button inside
 * the tile that no longer exists — is gone. Without this focus falls back to
 * the top of the document and a keyboard or screen-reader user has to find out
 * what happened; with it, the confirmation (and its Restore) is the next thing
 * they reach. `tabIndex={-1}` makes it focusable by script without adding a
 * stop to the tab order.
 */
export function FocusedNotice({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div ref={ref} tabIndex={-1} role="status" className="notice notice-success removed-notice">
      {children}
    </div>
  );
}
