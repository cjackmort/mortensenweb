"use client";

import { useState } from "react";

/** Copy the short link, for a text message or an email signature. */
export function CopyLink({ value }: { value: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      // A browser that refuses clipboard access: say so, and the link is
      // still on screen to select by hand.
      setCopied("failed");
    }
  }

  return (
    <p className="campaign-copy">
      <button type="button" className="secondary small" onClick={copy}>
        Copy link
      </button>
      <span role="status" className="hint">
        {copied === "yes" ? "Copied." : copied === "failed" ? "Your browser would not copy it — select the link instead." : ""}
      </span>
    </p>
  );
}
