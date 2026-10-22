"use client";

import { useActionState } from "react";
import {
  changeAdStateAction,
  goLiveAction,
  linkChannelAction,
  reviewAdAction,
  settleAdAction,
  syncAdAction,
  type AdminAdResult,
} from "./actions";

/**
 * The operator's controls on one campaign. Each is its own small form with
 * its result beside it, so pressing one never loses what another said.
 */

function Outcome({ state }: { state: AdminAdResult }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

export function ReviewForm({ campaign }: { campaign: string }) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(reviewAdAction, null);
  return (
    <form action={action} className="ad-admin-form">
      <input type="hidden" name="campaign" value={campaign} />
      <label htmlFor="review-note">If it needs changing, say what (the client sees this word for word)</label>
      <textarea id="review-note" name="note" rows={3} maxLength={1000} />
      <div className="actions">
        <button type="submit" name="decision" value="approve" disabled={pending}>
          Approve
        </button>
        <button type="submit" name="decision" value="reject" className="secondary" disabled={pending}>
          Send back to the client
        </button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

export function ChannelLinkForm({
  campaign,
  channel,
  platform,
  accountId,
  campaignId,
}: {
  campaign: string;
  channel: string;
  platform: "google_ads" | "meta";
  accountId: string | null;
  campaignId: string | null;
}) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(linkChannelAction, null);
  const google = platform === "google_ads";
  return (
    <form action={action} className="ad-admin-link">
      <input type="hidden" name="campaign" value={campaign} />
      <input type="hidden" name="channel" value={channel} />
      <label>
        {google ? "Client's Google Ads customer id" : "Meta ad account id"}
        <input name="accountId" defaultValue={accountId ?? ""} placeholder={google ? "123-456-7890" : "act_1234567890"} required />
      </label>
      <label>
        {google ? "Campaign id" : "Ad set id (or campaign id)"}
        <input name="campaignId" inputMode="numeric" defaultValue={campaignId ?? ""} placeholder="Digits only" required />
      </label>
      <button type="submit" className="secondary small" disabled={pending}>
        {campaignId ? "Update ids" : "Save ids"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function GoLiveButton({ campaign, ready }: { campaign: string; ready: boolean }) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(goLiveAction, null);
  return (
    <form action={action} className="ad-admin-form">
      <input type="hidden" name="campaign" value={campaign} />
      <button type="submit" disabled={pending || !ready}>
        {pending ? "Going live…" : "Mark as live and tell the client"}
      </button>
      {!ready && <p className="field-hint">Save the platform ids for every channel first.</p>}
      <Outcome state={state} />
    </form>
  );
}

const CHANGE_LABEL = {
  pause: "Pause",
  resume: "Resume",
  end: "End now",
  cancel: "Cancel (never ran)",
} as const;

export function StateButton({ campaign, change, manual }: { campaign: string; change: keyof typeof CHANGE_LABEL; manual: boolean }) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(changeAdStateAction, null);
  const reminder = manual && change !== "cancel" ? ` Remember to ${change} it in Google Ads and Meta too.` : "";
  return (
    <form
      action={action}
      className="ad-admin-inline"
      onSubmit={(event) => {
        if (!window.confirm(`${CHANGE_LABEL[change]} this campaign?${reminder}`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="campaign" value={campaign} />
      <input type="hidden" name="change" value={change} />
      <button type="submit" className="secondary small" disabled={pending}>
        {CHANGE_LABEL[change]}
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function SyncButton({ campaign, disabled }: { campaign: string; disabled: boolean }) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(syncAdAction, null);
  return (
    <form action={action} className="ad-admin-inline">
      <input type="hidden" name="campaign" value={campaign} />
      <button type="submit" className="secondary small" disabled={pending || disabled}>
        {pending ? "Syncing…" : "Sync results now"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

export function SettleForm({
  campaign,
  needsFinalSpend,
  byHand,
  refundLabel,
}: {
  campaign: string;
  needsFinalSpend: boolean;
  byHand: boolean;
  refundLabel: string;
}) {
  const [state, action, pending] = useActionState<AdminAdResult, FormData>(settleAdAction, null);
  return (
    <form
      action={action}
      className="ad-admin-form"
      onSubmit={(event) => {
        if (!window.confirm(`Settle this campaign? ${refundLabel}`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="campaign" value={campaign} />
      {needsFinalSpend && (
        <>
          <label htmlFor="final-spend">Final spend across every channel, from Google Ads and Meta</label>
          <input id="final-spend" name="finalSpend" inputMode="decimal" placeholder="e.g. 312.48" required />
        </>
      )}
      {byHand && (
        <label className="checkbox">
          <input type="checkbox" name="refundedByHand" required /> I have paid the refund back by hand (paid outside
          Stripe)
        </label>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Settling…" : "Settle and refund"}
      </button>
      <Outcome state={state} />
    </form>
  );
}
