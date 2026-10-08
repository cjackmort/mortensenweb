import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { openLead } from "@/db/repositories/client/leads";
import { formatDateTime } from "@/lib/time";
import { DeleteLeadForm, LeadStatusForm } from "../lead-controls";
import { RefreshOnRead } from "../refresh-on-read";
import { LeadReplyForm } from "../reply-form";
import { listLeadReplies, replyIdentity } from "@/db/repositories/client/lead-replies";

/**
 * One enquiry: who, how to reach them, what they said, and where it stands.
 *
 * Opening it marks it read (see `openLead`). Contact details are links — a
 * tap to call or email is the whole point of reading this on a phone.
 *
 * Everything rendered here was typed by a stranger into a public form. React
 * escapes it; nothing here uses `dangerouslySetInnerHTML`, and the only URL
 * rendered as a link is the page URL, which the parser accepted only as
 * http(s).
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Enquiry",
  robots: { index: false, follow: false },
};

export default async function LeadPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) notFound();

  const { publicId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  // Not in their plan: the Growth tab explains how to get it, and says how
  // many enquiries are already waiting — they are kept either way.
  if (!(await requireGrowthFeature(db, ctx, "leads"))) redirect("/dashboard/growth?locked=leads#leads");

  let lead;
  try {
    lead = await openLead(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [replies, identity] = await Promise.all([
    listLeadReplies(db, ctx, publicId),
    replyIdentity(db, ctx),
  ]);

  // The rest of what they filled in. Name, email, phone and message are
  // already shown above as the heading, the buttons and the message itself;
  // listing them again pushes the one field that is new — "Which service?" —
  // below the fold on a phone.
  const shown = new Set([lead.name, lead.email, lead.phone, lead.message].filter(Boolean));
  const otherFields = lead.fields.filter((field) => !shown.has(field.value));

  const telHref = lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, "")}` : null;

  return (
    <main className="shell">
      <RefreshOnRead wasUnread={lead.unread} />
      <p className="lead-back">
        <Link href="/dashboard/growth/leads">← All leads</Link>
      </p>

      <div className="masthead">
        <h1>{lead.name ?? lead.email ?? lead.phone ?? "Enquiry"}</h1>
        <span>
          {formatDateTime(lead.receivedAt)} · {lead.siteName}
        </span>
      </div>

      <section className="panel">
        <div className="panel-body">
          {(lead.email || telHref) && (
            <div className="lead-contact">
              {telHref && (
                <a className="button" href={telHref}>
                  Call {lead.phone}
                </a>
              )}
              {lead.email && (
                <a className={`button${telHref ? " secondary" : ""}`} href={`mailto:${lead.email}`}>
                  Email {lead.email}
                </a>
              )}
            </div>
          )}

          {lead.message && <p className="lead-message">{lead.message}</p>}

          {otherFields.length > 0 && (
            <dl className="detail-grid lead-fields">
              {otherFields.map((field, index) => (
                <div key={index} style={{ display: "contents" }}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {lead.pageUrl && (
            <p className="panel-note">
              Sent from{" "}
              <a href={lead.pageUrl} target="_blank" rel="noopener noreferrer nofollow">
                {lead.pageUrl}
              </a>
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Reply</h2>
        </div>
        <div className="panel-body">
          {replies.length > 0 && (
            <ol className="lead-thread">
              {replies.map((reply) => (
                <li key={reply.publicId}>
                  <p className="lead-thread-meta">
                    {reply.sentByName ?? "You"} · {formatDateTime(reply.createdAt)}
                    {reply.status === "failed" && (
                      <span className="pill pill-danger">Not delivered</span>
                    )}
                    {reply.status === "not_sent" && (
                      <span className="pill pill-warning">Not emailed</span>
                    )}
                  </p>
                  <p className="lead-thread-body">{reply.body}</p>
                </li>
              ))}
            </ol>
          )}

          {lead.email ? (
            <LeadReplyForm
              publicId={lead.publicId}
              customerEmail={lead.email}
              businessName={identity.businessName}
              replyTo={identity.replyTo}
              readOnly={ctx.impersonating}
            />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              They didn&rsquo;t leave an email address
              {telHref ? ", so the way to answer is to call them." : "."}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Where it stands</h2>
        </div>
        <div className="panel-body">
          <LeadStatusForm publicId={lead.publicId} current={lead.status} readOnly={ctx.impersonating} />
          <p className="panel-note">
            Only you set this. Marking enquiries won is how your monthly report can say
            how much work your website brought in.
          </p>
        </div>
      </section>

      <DeleteLeadForm publicId={lead.publicId} readOnly={ctx.impersonating} />
    </main>
  );
}
