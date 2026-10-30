"use client";

import { useActionState } from "react";
import { connectKeyAction, type ConnectionActionResult } from "./actions";

const API_KEYS_URL = "https://dashboard.stripe.com/apikeys";
const PORTAL_URL = "https://portal.mortensenweb.com";

type Permission = { name: string; section: string };

/** "Core: Charges and Refunds, Payment Disputes" — one line per heading on Stripe's form. */
function bySection(permissions: readonly Permission[]): [string, string[]][] {
  const sections = new Map<string, string[]>();
  for (const { name, section } of permissions) sections.set(section, [...(sections.get(section) ?? []), name]);
  return [...sections];
}

/**
 * Stripe connects by a restricted key the client makes for us, so its card
 * walks through Stripe's own "Create secret key" dialog, in its words, and
 * has a box to paste the key in. The box is a password field and is never
 * filled back in: after a refusal the client pastes the key again rather
 * than the page holding on to it.
 */
export function StripeKeyForm({ permissions, reconnect }: { permissions: readonly Permission[]; reconnect: boolean }) {
  const [state, action, pending] = useActionState<ConnectionActionResult | null, FormData>(connectKeyAction, null);

  return (
    <form action={action} className="connection-key">
      <input type="hidden" name="provider" value="stripe" />
      <ol className="connection-looks">
        <li>
          In Stripe, open{" "}
          <a href={API_KEYS_URL} target="_blank" rel="noopener noreferrer">
            Developers, API keys
          </a>{" "}
          and choose <strong>Create secret key</strong>.
        </li>
        <li>
          Choose <strong>Sharing with a third-party service</strong>. Vendor name <strong>MortensenWeb</strong>, URL{" "}
          <strong>{PORTAL_URL}</strong>.
        </li>
        <li>
          Choose <strong>Custom permissions</strong> and set these to <strong>Read</strong>, leaving everything else on
          None:
          <ul>
            {bySection(permissions).map(([section, names]) => (
              <li key={section}>
                {section}: {names.join(", ")}
              </li>
            ))}
          </ul>
        </li>
        <li>
          Create the key, copy it, and paste it below. It starts <code>rk_live_</code>.
        </li>
      </ol>
      <label htmlFor="stripe-key">Restricted key</label>
      <input
        id="stripe-key"
        type="password"
        name="key"
        required
        autoComplete="off"
        spellCheck={false}
        placeholder="rk_live_…"
        aria-describedby="stripe-key-hint"
        aria-invalid={state && !state.ok ? true : undefined}
      />
      <p className="field-hint" id="stripe-key-hint">
        We keep it encrypted and only ever read with it. Delete it in Stripe at any time and the connection stops.
      </p>
      <button type="submit" disabled={pending}>
        {pending ? "Checking the key…" : reconnect ? "Reconnect Stripe" : "Connect Stripe"}
      </button>
      {state && !state.ok && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
