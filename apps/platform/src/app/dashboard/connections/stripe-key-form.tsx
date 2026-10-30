"use client";

import { useActionState } from "react";
import { connectKeyAction, type ConnectionActionResult } from "./actions";

const API_KEYS_URL = "https://dashboard.stripe.com/apikeys";

/**
 * Stripe connects by a restricted key the client makes for us, so its card
 * says how to make one and has a box to paste it in. The box is a password
 * field and is never filled back in: after a refusal the client pastes the
 * key again rather than the page holding on to it.
 */
export function StripeKeyForm({ reads, reconnect }: { reads: readonly string[]; reconnect: boolean }) {
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
          and choose <strong>Create restricted key</strong>.
        </li>
        <li>
          Name it <strong>MortensenWeb</strong>.
        </li>
        <li>
          Set these to <strong>Read</strong>: {reads.join(", ")}. Leave everything else on None.
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
