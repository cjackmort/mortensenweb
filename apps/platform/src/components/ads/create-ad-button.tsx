"use client";

import { useFormStatus } from "react-dom";
import { createAdAction } from "@/app/dashboard/growth/ads/actions";

function Submit({ label, secondary }: { label: string; secondary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={secondary ? "secondary" : undefined} disabled={pending}>
      {pending ? "Writing your ad…" : label}
    </button>
  );
}

/**
 * "Create ad": one click drafts an ad from the business information and opens
 * it for editing. Nothing is charged until the client pays at the end.
 */
export function CreateAdButton({ label = "Create ad", secondary }: { label?: string; secondary?: boolean }) {
  return (
    <form action={createAdAction} className="ad-create">
      <Submit label={label} secondary={secondary} />
    </form>
  );
}
