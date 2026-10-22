"use client";

/**
 * Opens the browser's print dialog, where "Save as PDF" lives on every
 * platform. A client component only because `window.print` needs a browser;
 * the page's print stylesheet decides what comes out.
 */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="secondary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
