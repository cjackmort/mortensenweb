import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { isLeadView, listLeads, type LeadView } from "@/db/repositories/client/leads";
import { formatDateTime } from "@/lib/time";
import { LeadStatusPill } from "./status-pill";

/**
 * The leads inbox: every message from the client's contact form, newest first.
 *
 * The view lives in the URL, like the media library's filters, so "show me
 * the ones I won" is a link a client can bookmark or send us.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leads",
  robots: { index: false, follow: false },
};

const VIEWS: { value: LeadView; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const EMPTY: Record<LeadView, string> = {
  open: "No open enquiries. When someone fills in the contact form on your website, it appears here, and you still get the usual email about it.",
  won: "Nothing marked as won yet. Open an enquiry and mark it won when it turns into a job.",
  lost: "Nothing marked as lost.",
  archived: "Nothing archived.",
  all: "No enquiries yet. When someone fills in the contact form on your website, it appears here, and you still get the usual email about it.",
  new: "Nothing new.",
  contacted: "Nothing marked as contacted.",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; deleted?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">
          Your account is not linked to an organization yet. Please contact us.
        </p>
      </main>
    );
  }

  const params = await searchParams;
  const view: LeadView = isLeadView(params.view) ? params.view : "open";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  // Not in their plan: the Growth tab explains how to get it, and says how
  // many enquiries are already waiting — they are kept either way.
  if (!(await requireGrowthFeature(db, ctx, "leads"))) redirect("/dashboard/growth?locked=leads#leads");
  const { leads, hasMore } = await listLeads(db, ctx, { view, page });

  const href = (v: LeadView, p = 1) =>
    `/dashboard/growth/leads${v === "open" && p === 1 ? "" : `?view=${v}${p > 1 ? `&page=${p}` : ""}`}`;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Leads</h1>
        <span>From your website&rsquo;s contact form</span>
      </div>

      {params.deleted === "1" && (
        <p className="notice notice-success">
          Deleted. Netlify, which receives your form, still keeps its own copy.
        </p>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>{VIEWS.find((v) => v.value === view)?.label ?? "Enquiries"}</h2>
          <nav className="segmented lead-views" aria-label="Which enquiries">
            {VIEWS.map((v) => (
              <Link
                key={v.value}
                href={href(v.value)}
                aria-current={v.value === view ? "true" : undefined}
              >
                {v.label}
              </Link>
            ))}
          </nav>
        </div>

        {leads.length === 0 ? (
          <div className="empty">
            <p>{EMPTY[view]}</p>
          </div>
        ) : (
          <ul className="lead-list">
            {leads.map((lead) => (
              <li key={lead.publicId}>
                <Link
                  className={`lead-row${lead.unread ? " lead-unread" : ""}`}
                  href={`/dashboard/growth/leads/${lead.publicId}`}
                >
                  <span className="lead-row-head">
                    <span className="lead-row-name">
                      {lead.unread && <span className="sr-only">Unread: </span>}
                      {lead.name ?? lead.email ?? lead.phone ?? "Someone"}
                    </span>
                    <span className="lead-row-when">{formatDateTime(lead.receivedAt)}</span>
                  </span>
                  {lead.preview && <span className="lead-row-preview">{lead.preview}</span>}
                  <span className="lead-row-meta">
                    {lead.unread ? (
                      <span className="pill pill-accent">New</span>
                    ) : (
                      <LeadStatusPill status={lead.status} />
                    )}
                    {[lead.phone, lead.email].filter(Boolean).join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {(page > 1 || hasMore) && (
          <div className="panel-body lead-pager">
            {page > 1 ? <Link href={href(view, page - 1)}>← Newer</Link> : <span />}
            {hasMore && <Link href={href(view, page + 1)}>Older →</Link>}
          </div>
        )}
      </section>
    </main>
  );
}
