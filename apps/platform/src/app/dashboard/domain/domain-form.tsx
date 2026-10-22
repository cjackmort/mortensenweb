"use client";

import { useActionState } from "react";
import { confirmDomainAction, type DomainResult } from "./actions";

/** The domain they bought, where, and "Done, I've given you access". */
export function DomainForm({
  registrars,
  domain,
  registrar,
}: {
  registrars: Array<{ key: string; name: string }>;
  domain: string | null;
  registrar: string | null;
}) {
  const [state, action, pending] = useActionState<DomainResult | null, FormData>(confirmDomainAction, null);

  return (
    <form action={action} className="domain-form">
      <div className="profile-grid">
        <div>
          <label htmlFor="domain-name">Your domain</label>
          <input
            id="domain-name"
            name="domain"
            placeholder="yourbusiness.com"
            defaultValue={domain ?? ""}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <div>
          <label htmlFor="domain-registrar">Where you bought it</label>
          <select id="domain-registrar" name="registrar" defaultValue={registrar ?? ""} required>
            <option value="" disabled>
              Choose one
            </option>
            {registrars.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
            <option value="other">Somewhere else</option>
          </select>
        </div>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Done, I've given you access"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
