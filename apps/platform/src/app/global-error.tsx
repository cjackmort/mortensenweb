"use client";

import { useEffect } from "react";

/**
 * The boundary of last resort.
 *
 * `error.tsx` renders inside the root layout, so it cannot catch a throw from
 * the layout itself. This one replaces the whole document — which is why it
 * carries its own `<html>` and `<body>`, and why its styling is inline rather
 * than from `globals.css`: at this point nothing can be assumed to have
 * loaded, including the stylesheet.
 *
 * It should essentially never appear. Having it means that when it does, a
 * client gets a sentence and a way back instead of a blank white page.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[boundary] root layout error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          margin: 0,
          padding: "2rem 1.25rem",
          background: "#fbfaf8",
          color: "#1b1b1a",
        }}
      >
        <main style={{ maxWidth: "34rem", margin: "3rem auto" }}>
          <h1 style={{ fontSize: "1.35rem", marginBottom: "0.75rem" }}>
            The portal could not load
          </h1>
          <p style={{ lineHeight: 1.6, marginBottom: "1rem" }}>
            Something failed before the page could start. This is at our end.
          </p>
          <p style={{ lineHeight: 1.6, marginBottom: "1.5rem" }}>
            If you were part-way through sending a change request, please check
            your requests list before retyping it — it may already be there.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.6rem 1rem",
              borderRadius: "0.4rem",
              border: "1px solid #1b1b1a",
              background: "#1b1b1a",
              color: "#fff",
              fontSize: "0.95rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ marginTop: "1.5rem", fontSize: "0.85rem", color: "#666" }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
