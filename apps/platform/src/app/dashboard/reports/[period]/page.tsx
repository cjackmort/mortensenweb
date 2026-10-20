import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getMyReport } from "@/db/repositories/client/reports";
import { PrintButton } from "@/components/print-button";
import { ReportView } from "@/components/report-view";
import { isPeriod, reportWindow } from "@/lib/reports/period";

/**
 * One monthly report. The period in the URL picks a month within the
 * signed-in client's own reports; another client's month is a 404, the same
 * as a month that has no report.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  return {
    title: isPeriod(period) ? `${reportWindow(period).label} report` : "Report",
    robots: { index: false, follow: false },
  };
}

export default async function ReportPage({ params }: { params: Promise<{ period: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) notFound();

  const { period } = await params;
  const report = await getMyReport(await getDb(), tenantContextFrom(user, user.organizationId), period);
  if (!report.found) notFound();

  return (
    <main className="shell">
      <p className="no-print" style={{ margin: "0 0 1rem" }}>
        <Link href="/dashboard/reports">← All reports</Link>
      </p>
      {report.data ? (
        <ReportView data={report.data} builtAt={report.builtAt} actions={<PrintButton />} />
      ) : (
        <p className="notice">
          This report was saved in a format this version of the portal can&rsquo;t show. Please let us know and
          we&rsquo;ll rebuild it.
        </p>
      )}
    </main>
  );
}
