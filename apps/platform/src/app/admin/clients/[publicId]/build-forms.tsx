"use client";

import { useActionState } from "react";
import { setBuildAction, type BuildFormResult } from "./build-actions";

export interface BuildOption {
  key: string;
  name: string;
  priceCents: number;
  short: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
}

/**
 * The build a client's cart charges. The quoted price is optional: empty
 * charges the build's list price.
 */
export function BuildForm({
  clientPublicId,
  builds,
  currentKey,
  quotedCents,
}: {
  clientPublicId: string;
  builds: BuildOption[];
  currentKey: string | null;
  /** Their quote, when it differs from the list price. */
  quotedCents: number | null;
}) {
  const [state, action, pending] = useActionState<BuildFormResult | null, FormData>(setBuildAction, null);

  return (
    <form action={action}>
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <div className="profile-grid">
        <div>
          <label htmlFor="build-key">Build</label>
          <select id="build-key" name="buildKey" defaultValue={currentKey ?? builds[0]?.key}>
            {builds.map((build) => (
              <option key={build.key} value={build.key}>
                {build.name}, {dollars(build.priceCents)} ({build.short})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="build-price">Quoted price (optional)</label>
          <input
            id="build-price"
            name="price"
            inputMode="decimal"
            placeholder="List price"
            defaultValue={quotedCents !== null ? String(quotedCents / 100) : ""}
          />
        </div>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
