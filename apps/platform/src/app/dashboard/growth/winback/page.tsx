import Link from "next/link";
import { BackToGrowth } from "@/components/back-link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { winbackOverview } from "@/db/repositories/client/winback-campaigns";
import { MISSING_MESSAGE } from "@/lib/winback/readiness";
import { businessTimeZone, formatDate } from "@/lib/time";
import { createDraftAction } from "./actions";
import { CampaignStatusPill, resultsLine } from "./parts";
import "./winback.css";

/**
 * Win-back emails: what to send this season, and what has been sent.
 *
 * The suggestions are the portal's drafts for the business's trade and the
 * time of year; starting one opens it for editing, and nothing goes anywhere
 * until the client approves it.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Win-back emails",
  robots: { index: false, follow: false },
};

export default async function WinbackPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "winback"))) redirect("/dashboard/growth?locked=winback#winback");
  const overview = await winbackOverview(db, ctx);
  const month = new Date().toLocaleDateString("en-US", { month: "long", timeZone: businessTimeZone() });
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <BackToGrowth />
      <div className="masthead">
        <h1>Win-back emails</h1>
        <span>Seasonal reminders and offers to your past customers</span>
      </div>

      {!overview.readiness.ready && (
        <div className="notice notice-warning" role="status">
          <p style={{ margin: 0 }}>
            <strong>Before anything can be sent:</strong>
          </p>
          <ul style={{ margin: "0.4rem 0 0" }}>
            {overview.readiness.missing.map((m) => (
              <li key={m}>{MISSING_MESSAGE[m]}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="panel" aria-labelledby="winback-customers">
        <div className="panel-head">
          <h2 id="winback-customers">Your past customers</h2>
          <Link className="button secondary small" href="/dashboard/growth/winback/customers">
            See and add customers
          </Link>
        </div>
        <div className="panel-body">
          <p style={{ margin: 0 }}>
            {overview.reachable === 0 ? (
              <>
                No customers on your list yet. Enquiries you mark <strong>Won</strong> in your leads inbox are added
                automatically, or you can import a spreadsheet.
              </>
            ) : (
              <>
                <strong>{overview.reachable}</strong> {overview.reachable === 1 ? "customer" : "customers"} will get the
                next email you approve.
              </>
            )}
          </p>
        </div>
      </section>

      <section aria-labelledby="winback-ideas" className="winback-ideas">
        <h2 id="winback-ideas" className="growth-heading">
          Ideas for {month}
        </h2>
        <div className="growth-grid">
          {overview.suggestions.map((occasion) => (
            <article className="card growth-card winback-suggestion" key={occasion.key}>
              <h3>{occasion.label}</h3>
              <p>{occasion.why}</p>
              <p className="winback-subject">&ldquo;{occasion.subject}&rdquo;</p>
              <form action={createDraftAction}>
                <input type="hidden" name="occasion" value={occasion.key} />
                <button type="submit" className="secondary" disabled={readOnly}>
                  Start this draft
                </button>
              </form>
            </article>
          ))}
        </div>
        <p className="panel-note">
          Drafts are written from your General information: your name, phone, booking link and services. Nothing is
          sent until you approve it.
        </p>
      </section>

      <section className="panel" aria-labelledby="winback-sent">
        <div className="panel-head">
          <h2 id="winback-sent">Your emails</h2>
        </div>
        {overview.campaigns.length === 0 ? (
          <div className="empty">
            <p>No emails yet. Start one from an idea above.</p>
          </div>
        ) : (
          <ul className="winback-list">
            {overview.campaigns.map((c) => (
              <li key={c.publicId}>
                <Link href={`/dashboard/growth/winback/${c.publicId}`}>
                  <span className="winback-list-head">
                    {c.name}
                    <CampaignStatusPill status={c.status} scheduledFor={c.scheduledFor} />
                  </span>
                  <span className="winback-subject">{c.subject}</span>
                  <span className="winback-list-meta">
                    {resultsLine(c.status, c.stats, c.scheduledFor)}
                    {c.sentAt ? ` · finished ${formatDate(c.sentAt)}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
