import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getClientReportPreview } from "@/db/repositories/admin/reports";
import { PrintButton } from "@/components/print-button";
import { ReportView } from "@/components/report-view";
import { formatDateTime } from "@/lib/time";
import { ReportButton } from "../../report-forms";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Report preview",
  robots: { index: false, follow: false },
};

/**
 * The operator's preview of one client's report: the page exactly as the
 * client sees it, then the email exactly as it would go out, with the
 * buttons to rebuild and re-send. Rebuilding never emails.
 */
export default async function AdminReportPreviewPage({
  params,
}: {
  params: Promise<{ publicId: string; period: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const { publicId, period } = await params;
  const ctx = adminContextFrom(user);

  let preview;
  try {
    preview = await getClientReportPreview(ctx, await getDb(), publicId, period);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!preview) notFound();

  const status = preview.emailStatus
    ? `${preview.emailStatus}${preview.emailedAt ? `, ${formatDateTime(preview.emailedAt)}` : ""}${preview.emailError ? ` (${preview.emailError})` : ""}`
    : "not emailed";

  return (
    <main className="shell">
      <p className="no-print" style={{ margin: "0 0 1rem" }}>
        <Link href={`/admin/clients/${publicId}?section=reports`}>← Monthly reports</Link>
      </p>

      <section className="card no-print">
        <h2>Before you send</h2>
        <dl className="detail-grid">
          <dt>Email</dt>
          <dd>{status}</dd>
          <dt>Goes to</dt>
          <dd>{preview.recipients.length ? preview.recipients.join(", ") : "Nobody: no portal users and no contact email"}</dd>
          <dt>Monthly emails</dt>
          <dd>{preview.emailsOff ? "Off: they opted out" : "On"}</dd>
        </dl>
        <div className="action-block" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <ReportButton
            clientPublicId={publicId}
            period={period}
            intent="resend"
            label={preview.emailStatus === "sent" ? "Re-send email" : "Send email"}
            confirm="Email this report to the client now?"
          />
          <ReportButton clientPublicId={publicId} period={period} intent="rebuild" label="Rebuild from today's data" secondary />
        </div>
      </section>

      {preview.data ? (
        <ReportView data={preview.data} builtAt={preview.builtAt} actions={<PrintButton />} inboxHref={null} />
      ) : (
        <p className="notice notice-danger">This report can&rsquo;t be read by this version of the portal. Rebuild it.</p>
      )}

      {preview.email && (
        <section className="card no-print" style={{ marginTop: "1.25rem" }}>
          <h2>The email</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Subject: <strong>{preview.email.subject}</strong>
          </p>
          {/* Sandboxed with no permissions: the email's HTML is rendered, never run. */}
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.email.html}
            style={{ width: "100%", height: "44rem", border: "1px solid var(--border)", background: "#f6f7f9" }}
          />
        </section>
      )}
    </main>
  );
}
