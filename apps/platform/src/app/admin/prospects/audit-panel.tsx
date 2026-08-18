"use client";

import { useActionState } from "react";
import {
  auditProspectAction,
  factVerdictAction,
  type ProspectResult,
} from "./actions";

/**
 * Reading a prospect's site, and deciding what of it is true.
 *
 * The review is the point of this screen, not the crawl. A crawled fact is a
 * candidate: it says "their site claims this", which is not the same as "this
 * is true", and the difference is what stops a concept site publishing a phone
 * number that changed two years ago.
 *
 * Facts are ordered by confidence so the ones most likely to be right — the
 * ones a business stated in structured data — are cleared quickly, and the
 * guesswork is left in a pile at the bottom where it belongs.
 */

export interface FactRow {
  id: string;
  key: string;
  value: string | null;
  sourceUrl: string | null;
  verification: string;
  confidence: number | null;
}

const HUMAN_KEY: Record<string, string> = {
  business_name: "Business name",
  page_title: "Page title",
  meta_description: "Description",
  headline: "Headline",
  phone: "Phone",
  email: "Email",
  street_address: "Street",
  locality: "Town",
  region: "State",
  postal_code: "Postcode",
  opening_hours: "Hours",
};

function label(key: string): string {
  return HUMAN_KEY[key] ?? key.replace(/_/g, " ");
}

function FactVerdict({ fact }: { fact: FactRow }) {
  const [state, action, pending] = useActionState<ProspectResult | null, FormData>(
    factVerdictAction,
    null,
  );

  if (state?.ok) {
    return <span className="muted">{state.message}</span>;
  }

  // Never offered for a sensitive claim. The server refuses these too — the
  // absent button is a courtesy, the refusal is the control.
  if (fact.verification === "sensitive") {
    return (
      <span className="muted">
        Confirm this with the owner and add it by hand.
      </span>
    );
  }

  if (fact.verification === "user_verified") {
    return <span className="pill pill-success">confirmed</span>;
  }

  if (fact.verification === "conflicting") {
    return <span className="pill pill-neutral">marked wrong</span>;
  }

  return (
    <>
      {state && !state.ok && <span className="error">{state.message}</span>}
      <form action={action} style={{ display: "inline" }}>
        <input type="hidden" name="factId" value={fact.id} />
        <input type="hidden" name="verdict" value="user_verified" />
        <button type="submit" disabled={pending}>
          {pending ? "…" : "Correct"}
        </button>
      </form>{" "}
      <form action={action} style={{ display: "inline" }}>
        <input type="hidden" name="factId" value={fact.id} />
        <input type="hidden" name="verdict" value="conflicting" />
        <button type="submit" className="secondary" disabled={pending}>
          Wrong
        </button>
      </form>
    </>
  );
}

export function AuditPanel({
  prospectPublicId,
  websiteUrl,
  facts,
  lastAudit,
}: {
  prospectPublicId: string;
  websiteUrl: string | null;
  facts: FactRow[];
  lastAudit: { status: string; pagesFetched: number; error: string | null } | null;
}) {
  const [state, action, pending] = useActionState<ProspectResult | null, FormData>(
    auditProspectAction,
    null,
  );

  const sensitive = facts.filter((f) => f.verification === "sensitive");
  const reviewable = facts.filter((f) => f.verification !== "sensitive");

  return (
    <div style={{ marginTop: "1rem" }}>
      <div className="card-head">
        <h3 style={{ margin: 0, fontSize: "1rem" }}>Their current site</h3>
        {lastAudit && (
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {lastAudit.status === "succeeded"
              ? `${lastAudit.pagesFetched} pages read`
              : lastAudit.status}
          </span>
        )}
      </div>

      {!websiteUrl ? (
        <p className="muted">No website recorded for this prospect.</p>
      ) : (
        <>
          <p style={{ margin: "0.35rem 0 0.6rem", fontSize: "0.9rem" }}>
            <a href={websiteUrl} target="_blank" rel="noopener noreferrer">
              {websiteUrl}
            </a>
          </p>

          {state && (
            <p className={state.ok ? "muted" : "error"}>{state.message}</p>
          )}

          <form action={action}>
            <input type="hidden" name="prospectPublicId" value={prospectPublicId} />
            <button type="submit" disabled={pending}>
              {pending ? "Reading their site…" : facts.length > 0 ? "Read it again" : "Read their site"}
            </button>
          </form>
        </>
      )}

      {reviewable.length > 0 && (
        <>
          <p className="muted" style={{ margin: "1rem 0 0.5rem", fontSize: "0.85rem" }}>
            Their site says the following. Confirm what&rsquo;s right — only
            confirmed facts go on a site we build.
          </p>
          <table className="table">
            <tbody>
              {reviewable.map((fact) => (
                <tr key={fact.id}>
                  <td data-label="Field" style={{ whiteSpace: "nowrap" }}>
                    {label(fact.key)}
                  </td>
                  <td data-label="Value">
                    {fact.value}
                    {fact.sourceUrl && (
                      <>
                        {" "}
                        <a
                          href={fact.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="muted"
                          style={{ fontSize: "0.8rem" }}
                        >
                          source
                        </a>
                      </>
                    )}
                  </td>
                  <td data-label="Verdict">
                    <FactVerdict fact={fact} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {sensitive.length > 0 && (
        <div className="notice" style={{ marginTop: "1rem" }}>
          <strong>Not published automatically</strong>
          <p style={{ margin: "0.35rem 0 0.5rem", fontSize: "0.88rem" }}>
            Licence numbers, prices, guarantees and similar claims. Getting one
            of these wrong on a real business&rsquo;s site is their legal
            problem, so we never publish one because a crawler read it.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.88rem" }}>
            {sensitive.map((fact) => (
              <li key={fact.id}>
                {label(fact.key)}: {fact.value}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
