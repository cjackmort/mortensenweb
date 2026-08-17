"use client";

import { useActionState } from "react";
import {
  goLiveAction,
  sendDnsAction,
  toggleAutomationAction,
  type LaunchResult,
} from "./launch-actions";

/**
 * Launch controls for one site.
 *
 * Presented in the order they happen, with the state of each visible: an
 * operator returning to this page after a week should be able to tell where
 * things stand without reading a log.
 */

function Result({ state }: { state: LaunchResult | null }) {
  if (!state) return null;
  return (
    <div className={state.ok ? "notice notice-success" : "error"}>
      <p style={{ margin: 0 }}>{state.message}</p>
      {state.ok && state.note && (
        <p style={{ margin: "0.5rem 0 0" }}>{state.note}</p>
      )}
    </div>
  );
}

export function LaunchPanel({
  sitePublicId,
  clientPublicId,
  domain,
  status,
  dnsSentAt,
  liveVerifiedAt,
  automationEnabled,
  hasRepository,
}: {
  sitePublicId: string;
  clientPublicId: string;
  domain: string | null;
  status: string;
  dnsSentAt: Date | null;
  liveVerifiedAt: Date | null;
  automationEnabled: boolean;
  hasRepository: boolean;
}) {
  const [dnsState, dnsAction, sendingDns] = useActionState<
    LaunchResult | null,
    FormData
  >(sendDnsAction, null);

  const [liveState, liveAction, goingLive] = useActionState<
    LaunchResult | null,
    FormData
  >(goLiveAction, null);

  const [autoState, autoAction, toggling] = useActionState<
    LaunchResult | null,
    FormData
  >(toggleAutomationAction, null);

  const dateOnly = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div>
      <dl className="detail-grid" style={{ marginBottom: "1rem" }}>
        <dt>Automation</dt>
        <dd>
          {!hasRepository
            ? "no repository connected"
            : automationEnabled
              ? "enabled"
              : "off — agents cannot write here"}
        </dd>
        <dt>DNS instructions</dt>
        <dd>{dnsSentAt ? `sent ${dateOnly(dnsSentAt)}` : "not sent"}</dd>
        <dt>Live check</dt>
        <dd>
          {liveVerifiedAt
            ? `verified ${dateOnly(liveVerifiedAt)}`
            : "not verified"}
        </dd>
      </dl>

      <Result state={autoState} />
      {hasRepository && (
        <form action={autoAction} style={{ marginBottom: "1rem" }}>
          <input type="hidden" name="sitePublicId" value={sitePublicId} />
          <input type="hidden" name="clientPublicId" value={clientPublicId} />
          <input
            type="hidden"
            name="allow"
            value={automationEnabled ? "false" : "true"}
          />
          <button type="submit" className="secondary" disabled={toggling}>
            {toggling
              ? "Saving…"
              : automationEnabled
                ? "Turn automation off"
                : "Turn automation on"}
          </button>
          {!automationEnabled && (
            <p className="field-hint">
              Until this is on, no agent can open a pull request against this
              repository — dispatches will be refused.
            </p>
          )}
        </form>
      )}

      <Result state={dnsState} />
      <form action={dnsAction} style={{ marginBottom: "1rem" }}>
        <input type="hidden" name="sitePublicId" value={sitePublicId} />
        <input type="hidden" name="clientPublicId" value={clientPublicId} />
        <button type="submit" className="secondary" disabled={sendingDns || !domain}>
          {sendingDns
            ? "Sending…"
            : dnsSentAt
              ? "Send DNS instructions again"
              : "Send DNS instructions"}
        </button>
        {!domain && (
          <p className="field-hint">
            Record the client&rsquo;s domain against this site first.
          </p>
        )}
      </form>

      <Result state={liveState} />
      <form action={liveAction}>
        <input type="hidden" name="sitePublicId" value={sitePublicId} />
        <input type="hidden" name="clientPublicId" value={clientPublicId} />
        <button type="submit" disabled={goingLive || !domain}>
          {goingLive
            ? "Checking…"
            : status === "live"
              ? "Re-check and refresh"
              : "Check the domain and go live"}
        </button>
        {/* The button does not promise to make it live — it promises to check.
            Saying so prevents the operator reading a refusal as a failure of
            the button rather than of DNS. */}
        <p className="field-hint">
          This fetches {domain ? domain : "the domain"} for real. Nothing is
          marked live unless it answers.
        </p>
      </form>
    </div>
  );
}
