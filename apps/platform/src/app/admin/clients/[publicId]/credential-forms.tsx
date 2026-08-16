"use client";

import { useActionState } from "react";
import {
  activateClientAction,
  reissueCredentialAction,
  type CredentialResult,
} from "./actions";

/**
 * Client components, purely so the issued credential can be rendered from the
 * action's return value instead of a redirect. See `actions.ts` for why that
 * matters: a temporary password in a query string ends up in browser history
 * and in every access log between here and the browser.
 *
 * Nothing secret is held in component state longer than the page lives, and
 * navigating away loses it. That is the intended behaviour, and the panel says
 * so rather than letting the operator discover it.
 */

function EmailOutcome({ status }: { status: "sent" | "skipped" | "failed" }) {
  if (status === "sent") {
    return <>The welcome email has been sent.</>;
  }
  if (status === "failed") {
    return (
      <>
        <strong>The welcome email failed to send.</strong> Pass the details on
        another way, or reissue once email is working.
      </>
    );
  }
  return (
    <>
      <strong>No email was sent</strong> — either you left the box unticked, or
      the mailer has no API key configured and logged the message to the server
      console instead.
    </>
  );
}

function CredentialReveal({ result }: { result: CredentialResult }) {
  if (!result.ok) {
    return <p className="error">{result.message}</p>;
  }

  return (
    <div className="credential">
      <p style={{ margin: "0 0 0.75rem", fontWeight: 600 }}>
        {result.kind === "activated"
          ? "Account created."
          : "New temporary password issued."}{" "}
        Copy this now — it is not stored and cannot be shown again.
      </p>

      <dl className="credential-grid">
        <dt>Username</dt>
        <dd>{result.username}</dd>
        <dt>Temporary password</dt>
        <dd>{result.temporaryPassword}</dd>
        <dt>Sent to</dt>
        <dd>{result.email}</dd>
        <dt>Expires</dt>
        <dd>{result.expiresAt}</dd>
      </dl>

      <p className="muted" style={{ margin: "0.75rem 0 0", fontSize: "0.85rem" }}>
        <EmailOutcome status={result.emailStatus} />
      </p>

      {result.kind === "reissued" && (
        <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
          Any session this client had open has been signed out, and their
          previous password no longer works.
        </p>
      )}

      {/*
        The page behind this panel is deliberately not refreshed while the
        credential is on screen — see `actions.ts`. Refreshing is offered as an
        explicit action so it happens after the password has been copied, never
        before.
      */}
      <button
        type="button"
        className="secondary"
        style={{ marginTop: "1rem" }}
        onClick={() => window.location.reload()}
      >
        I&rsquo;ve copied it — refresh this page
      </button>
    </div>
  );
}

export function ActivateForm({
  clientPublicId,
  defaultName,
  defaultEmail,
}: {
  clientPublicId: string;
  defaultName: string | null;
  defaultEmail: string | null;
}) {
  const [state, formAction, pending] = useActionState<
    CredentialResult | null,
    FormData
  >(activateClientAction, null);

  // Once the credential is on screen, replacing the form with it prevents the
  // obvious double-submit that would issue a second password and invalidate the
  // one the operator is mid-way through reading out.
  if (state?.ok) return <CredentialReveal result={state} />;

  return (
    <form action={formAction}>
      {state && !state.ok && <CredentialReveal result={state} />}

      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      <label htmlFor="contactName">Contact name</label>
      <input
        id="contactName"
        name="contactName"
        type="text"
        defaultValue={defaultName ?? ""}
        autoComplete="off"
      />

      <label htmlFor="contactEmail">Contact email</label>
      <input
        id="contactEmail"
        name="contactEmail"
        type="email"
        defaultValue={defaultEmail ?? ""}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        required
      />

      <label className="checkbox">
        <input type="checkbox" name="sendWelcome" defaultChecked />
        <span>Send the welcome email with these credentials</span>
      </label>

      <button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Activate this client"}
      </button>

      <p className="muted" style={{ fontSize: "0.8rem", margin: "0.75rem 0 0" }}>
        Only do this once the client has agreed terms and paid. Activation
        grants real access — the platform will not infer it from a payment row.
      </p>
    </form>
  );
}

export function ReissueForm({
  clientPublicId,
  userPublicId,
  email,
}: {
  clientPublicId: string;
  userPublicId: string;
  email: string;
}) {
  const [state, formAction, pending] = useActionState<
    CredentialResult | null,
    FormData
  >(reissueCredentialAction, null);

  if (state?.ok) return <CredentialReveal result={state} />;

  return (
    <form action={formAction}>
      {state && !state.ok && <CredentialReveal result={state} />}

      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="userPublicId" value={userPublicId} />

      <label className="checkbox">
        <input type="checkbox" name="sendWelcome" defaultChecked />
        <span>Email the new credentials to {email}</span>
      </label>

      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Issuing…" : "Issue a new temporary password"}
      </button>

      <p className="muted" style={{ fontSize: "0.8rem", margin: "0.75rem 0 0" }}>
        For &ldquo;I lost the email&rdquo; and &ldquo;it expired&rdquo;. This
        signs the client out everywhere and replaces their current password.
      </p>
    </form>
  );
}
