"use client";

import { useActionState, useState } from "react";
import type { CampaignSiteOption } from "@/db/repositories/client/campaigns";
import {
  createCampaignAction,
  setCampaignPausedAction,
  updateCampaignAction,
  type CampaignActionResult,
} from "./actions";

const PLACEMENTS: { value: string; label: string }[] = [
  { value: "door_hangers", label: "Door hangers" },
  { value: "flyers", label: "Flyers" },
  { value: "yard_signs", label: "Yard signs" },
  { value: "truck", label: "Truck or van" },
  { value: "business_cards", label: "Business cards" },
  { value: "other", label: "Something else" },
];

function Outcome({ state }: { state: CampaignActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

/** New campaign: a name, where it goes, and which page it opens. */
export function CreateCampaignForm({ sites, readOnly }: { sites: CampaignSiteOption[]; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<CampaignActionResult | null, FormData>(
    createCampaignAction,
    null,
  );
  const ready = sites.filter((site) => site.origin);
  const [sitePublicId, setSitePublicId] = useState(ready[0]?.publicId ?? "");
  const origin = ready.find((site) => site.publicId === sitePublicId)?.origin ?? "";

  if (ready.length === 0) {
    return (
      <p className="notice">
        Your website isn&rsquo;t live at its own address yet, so a code would have nowhere to send people. This
        switches on when it launches.
      </p>
    );
  }

  return (
    <form action={formAction} className="campaign-form">
      <label htmlFor="campaign-name">Name</label>
      <input
        id="campaign-name"
        name="name"
        maxLength={80}
        required
        placeholder="Spring door hangers"
        disabled={readOnly || pending}
      />
      <p className="field-hint">For you only. Visitors never see it.</p>

      <label htmlFor="campaign-placement">Where it&rsquo;s used</label>
      <select id="campaign-placement" name="placement" defaultValue="door_hangers" disabled={readOnly || pending}>
        {PLACEMENTS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>

      {ready.length > 1 ? (
        <>
          <label htmlFor="campaign-site">Website</label>
          <select
            id="campaign-site"
            name="site"
            value={sitePublicId}
            onChange={(event) => setSitePublicId(event.target.value)}
            disabled={readOnly || pending}
          >
            {ready.map((site) => (
              <option key={site.publicId} value={site.publicId}>
                {site.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <input type="hidden" name="site" value={sitePublicId} />
      )}

      <label htmlFor="campaign-destination">Page it opens</label>
      <input
        id="campaign-destination"
        name="destination"
        maxLength={300}
        placeholder="/ (your home page)"
        disabled={readOnly || pending}
      />
      <p className="field-hint">
        Leave blank for your home page, or paste a page from {origin.replace(/^https?:\/\//, "")}. You can change
        it later without reprinting.
      </p>

      <Outcome state={state} />
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}

/** Rename it, or point the printed code at another page. */
export function EditCampaignForm({
  publicId,
  name,
  destinationPath,
  readOnly,
}: {
  publicId: string;
  name: string;
  destinationPath: string;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<CampaignActionResult | null, FormData>(
    updateCampaignAction,
    null,
  );
  return (
    <form action={formAction} className="campaign-form">
      <input type="hidden" name="campaign" value={publicId} />
      <label htmlFor="edit-name">Name</label>
      <input id="edit-name" name="name" defaultValue={name} maxLength={80} required disabled={readOnly || pending} />
      <label htmlFor="edit-destination">Page it opens</label>
      <input
        id="edit-destination"
        name="destination"
        defaultValue={destinationPath}
        maxLength={300}
        disabled={readOnly || pending}
      />
      <p className="field-hint">The printed code stays the same. Only where it sends people changes.</p>
      <Outcome state={state} />
      <button type="submit" className="secondary" disabled={readOnly || pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

/** Stop or restart counting. The code keeps working either way. */
export function PauseCampaignButton({
  publicId,
  paused,
  readOnly,
}: {
  publicId: string;
  paused: boolean;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<CampaignActionResult | null, FormData>(
    setCampaignPausedAction,
    null,
  );
  return (
    <form action={formAction} className="plan-action">
      <input type="hidden" name="campaign" value={publicId} />
      <input type="hidden" name="paused" value={paused ? "0" : "1"} />
      <button type="submit" className="secondary" disabled={readOnly || pending}>
        {pending ? "Saving…" : paused ? "Start counting again" : "Pause counting"}
      </button>
      <Outcome state={state} />
    </form>
  );
}
