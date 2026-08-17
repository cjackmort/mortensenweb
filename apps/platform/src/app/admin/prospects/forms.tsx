"use client";

import { useActionState, useState } from "react";
import {
  buildConceptAction,
  createProspectAction,
  revokeSharesAction,
  shareConceptAction,
  type ProspectResult,
} from "./actions";

/**
 * Prospect intake and the concept pipeline, from the operator's side.
 *
 * The intake form is collapsed by default. This page is read far more often
 * than it is written to — the common visit is checking where things stand, not
 * adding somebody — and a permanently expanded eleven-field form pushes the
 * list of prospects below the fold on a laptop.
 */

interface PlanOption {
  key: string;
  name: string;
  defaultMonthlyCents: number;
  includedChangesPerMonth: number | null;
  includesAnalytics: boolean;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function planLabel(plan: PlanOption): string {
  const changes =
    plan.includedChangesPerMonth === null
      ? "unlimited changes"
      : `${plan.includedChangesPerMonth} ${plan.includedChangesPerMonth === 1 ? "change" : "changes"}/mo`;
  return `${plan.name} — ${money(plan.defaultMonthlyCents)}/mo, ${changes}${
    plan.includesAnalytics ? ", analytics" : ""
  }`;
}

function Result({ state }: { state: ProspectResult | null }) {
  if (!state) return null;
  return (
    <div className={state.ok ? "notice notice-success" : "error"}>
      <p style={{ margin: 0 }}>{state.message}</p>
      {state.ok && state.url && (
        <p style={{ margin: "0.5rem 0 0" }}>
          {/* Selectable rather than a link: the operator's job here is to copy
              it into an email they are writing themselves, not to open it. */}
          <code style={{ wordBreak: "break-all", userSelect: "all" }}>
            {state.url}
          </code>
        </p>
      )}
      {state.ok && state.warning && (
        <p style={{ margin: "0.5rem 0 0" }}>
          <strong>Note:</strong> {state.warning}
        </p>
      )}
    </div>
  );
}

export function NewProspectForm({ plans }: { plans: PlanOption[] }) {
  const [state, formAction, pending] = useActionState<
    ProspectResult | null,
    FormData
  >(createProspectAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>
          Add a potential client
        </button>
      </div>
    );
  }

  return (
    <form className="card" action={formAction}>
      <div className="card-head">
        <h2>Add a potential client</h2>
      </div>

      <Result state={state} />

      <label htmlFor="businessName">Business name</label>
      <input id="businessName" name="businessName" required minLength={2} />

      <label htmlFor="planKey">Plan to pitch</label>
      <select id="planKey" name="planKey" defaultValue={plans[0]?.key ?? ""}>
        <option value="">Decide later</option>
        {plans.map((plan) => (
          <option key={plan.key} value={plan.key}>
            {planLabel(plan)}
          </option>
        ))}
      </select>
      <p className="field-hint">
        This decides what the demo shows — a plan without analytics
        shouldn&rsquo;t be pitched with an analytics dashboard.
      </p>

      <label htmlFor="sourceWebsiteUrl">Current website</label>
      <input
        id="sourceWebsiteUrl"
        name="sourceWebsiteUrl"
        placeholder="example.com"
        autoCapitalize="none"
        spellCheck={false}
      />

      <label htmlFor="industry">Industry</label>
      <input id="industry" name="industry" placeholder="HVAC, detailing, …" />

      <label htmlFor="location">Location</label>
      <input id="location" name="location" placeholder="Fort Collins, CO" />

      <label htmlFor="serviceArea">Service area</label>
      <input id="serviceArea" name="serviceArea" placeholder="Northern Colorado" />

      <label htmlFor="tone">Tone</label>
      <input id="tone" name="tone" placeholder="Straightforward, family-run" />

      <label htmlFor="notes">Notes</label>
      <textarea id="notes" name="notes" rows={3} />

      <label htmlFor="contactName">Contact name</label>
      <input id="contactName" name="contactName" />

      <label htmlFor="contactEmail">Contact email</label>
      <input id="contactEmail" name="contactEmail" type="email" autoCapitalize="none" />

      <label htmlFor="contactPhone">Contact phone</label>
      <input id="contactPhone" name="contactPhone" type="tel" />

      <label htmlFor="consentNote">Why we hold this contact</label>
      <input
        id="consentNote"
        name="consentNote"
        placeholder="Met at the chamber breakfast, asked us to follow up"
      />
      {/* Said plainly, because an operator reasonably assumes a CRM emails
          people, and the guarantee only holds if they know it holds. */}
      <p className="field-hint">
        Nothing here is ever sent automatically. The portal has no way to
        contact a prospect — every message comes from you.
      </p>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add prospect"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function BuildConceptForm({
  prospectPublicId,
}: {
  prospectPublicId: string;
}) {
  const [state, formAction, pending] = useActionState<
    ProspectResult | null,
    FormData
  >(buildConceptAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Build a demo
      </button>
    );
  }

  return (
    <form action={formAction}>
      <Result state={state} />
      <input type="hidden" name="prospectPublicId" value={prospectPublicId} />

      <label htmlFor={`colour-${prospectPublicId}`}>Colours and look</label>
      <textarea id={`colour-${prospectPublicId}`} name="colourDirection" rows={2} />

      <label htmlFor={`features-${prospectPublicId}`}>Pages and features</label>
      <textarea id={`features-${prospectPublicId}`} name="features" rows={2} />

      <label htmlFor={`content-${prospectPublicId}`}>Content notes</label>
      <textarea id={`content-${prospectPublicId}`} name="contentNotes" rows={2} />
      <p className="field-hint">
        Leave blank to use what&rsquo;s already recorded against this prospect.
        The agent will use placeholders for anything unverified rather than
        inventing details.
      </p>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Setting up…" : "Create repo and build"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ShareConceptForm({
  prospectPublicId,
  hasLiveShare,
}: {
  prospectPublicId: string;
  hasLiveShare: boolean;
}) {
  const [shareState, shareAction, sharing] = useActionState<
    ProspectResult | null,
    FormData
  >(shareConceptAction, null);
  const [revokeState, revokeAction, revoking] = useActionState<
    ProspectResult | null,
    FormData
  >(revokeSharesAction, null);

  return (
    <div>
      <Result state={shareState} />
      <Result state={revokeState} />

      <div className="actions">
        <form action={shareAction}>
          <input type="hidden" name="prospectPublicId" value={prospectPublicId} />
          <button type="submit" disabled={sharing || revoking}>
            {sharing ? "Approving…" : "Approve and get a link"}
          </button>
        </form>

        {hasLiveShare && (
          <form action={revokeAction}>
            <input
              type="hidden"
              name="prospectPublicId"
              value={prospectPublicId}
            />
            <button
              type="submit"
              className="secondary"
              disabled={sharing || revoking}
            >
              {revoking ? "Revoking…" : "Revoke links"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
