"use client";

import { useEffect } from "react";

/**
 * What a client sees when something throws.
 *
 * There was no error boundary anywhere in this application before, which is
 * most of the reason clients reported "this page couldn't load" with nothing
 * useful attached. Any uncaught throw — a failed server action, a database
 * timeout — rendered the framework's own generic failure screen: no context,
 * no way back, and no indication whether the thing they had just done had
 * worked.
 *
 * That last part is what makes this page's wording matter more than its
 * appearance. Someone who has just pressed Send needs to know whether to press
 * it again, and the honest answer is "check the list before you retype it" —
 * because the request very often *was* saved. Telling them to try again is how
 * duplicates get created.
 */

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is what correlates this screen with a line in the function
    // logs. Without it, a client saying "it broke" and a log full of stack
    // traces cannot be matched up.
    console.error("[boundary] unhandled error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <main className="page">
      <div className="card">
        <div className="card-head">
          <h2>Something went wrong at our end</h2>
        </div>

        <p>
          This is our problem, not something you did. The page stopped
          before it finished loading.
        </p>

        <div className="notice">
          <p style={{ marginTop: 0 }}>
            <strong>If you were sending a change request:</strong> check your
            list of requests before retyping it. It may well have been saved —
            sending it again would create a second one.
          </p>
          <p style={{ marginBottom: 0 }}>
            <a href="/dashboard/requests">Open your requests</a>
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" onClick={reset} style={{ width: "auto" }}>
            Try again
          </button>
          <a
            className="button secondary"
            href="/dashboard"
            style={{ width: "auto" }}
          >
            Back to your site
          </a>
        </div>

        {error.digest && (
          <p className="field-hint" style={{ marginTop: "1rem" }}>
            If you get in touch about this, quoting{" "}
            <code>{error.digest}</code> lets us find exactly what happened.
          </p>
        )}
      </div>
    </main>
  );
}
