import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { BarList } from "@/components/charts";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { getCampaign } from "@/db/repositories/client/campaigns";
import { campaignStats } from "@/db/repositories/client/campaign-stats";
import { qrMatrix, qrPathData } from "@/lib/campaigns/qr";
import { formatDateWithYear } from "@/lib/time";
import { EditCampaignForm, PauseCampaignButton } from "../campaign-forms";
import { QrPreview, ScanChart } from "../campaign-visuals";
import { CopyLink } from "./copy-link";

/**
 * One campaign: its code, its downloads, its scans, and the two things a
 * printed code can still change — the page it opens and whether it counts.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaign",
  robots: { index: false, follow: false },
};

const DAYS = 30;

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "campaigns"))) redirect("/dashboard/growth?locked=campaigns#campaigns");

  const { publicId } = await params;
  let campaign;
  try {
    campaign = await getCampaign(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const stats = await campaignStats(db, ctx, { days: DAYS, campaignPublicId: campaign.publicId });
  const { created } = await searchParams;

  const matrix = qrMatrix(campaign.shortLink);
  const download = `/dashboard/growth/campaigns/${campaign.publicId}/qr`;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          {campaign.name}
          <span className="masthead-sub">
            {campaign.placementLabel} · {campaign.siteName}
          </span>
        </h1>
      </div>

      {created === "1" && (
        <p className="notice notice-success">
          Your campaign is ready. Download the code below and send it to whoever prints for you.
        </p>
      )}
      {campaign.paused && (
        <p className="notice notice-info">
          Counting is paused. The code still opens your page; scans are not counted until you start again.
        </p>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Your QR code</h2>
        </div>
        <div className="panel-split panel-split-2 campaign-code">
          <div>
            <QrPreview path={qrPathData(matrix)} size={matrix.length} label={`QR code for ${campaign.printedLink}`} />
          </div>
          <div>
            <h3>Short link</h3>
            <p className="campaign-link">
              <strong>{campaign.printedLink}</strong>
            </p>
            <CopyLink value={campaign.shortLink} />
            <p className="field-hint campaign-link-hint">
              Print this under the code, for anyone who would rather type it.
            </p>

            <h3>Opens</h3>
            <p className="campaign-link">
              {campaign.destinationUrl ? (
                <a href={campaign.destinationUrl} target="_blank" rel="noreferrer">
                  {campaign.destinationUrl.split("?")[0]}
                </a>
              ) : (
                "Your website has no address yet."
              )}
            </p>

            <h3>Download</h3>
            <div className="campaign-downloads">
              <a className="button" href={`${download}?format=svg`} download>
                SVG, for printers
              </a>
              <a className="button secondary" href={`${download}?format=png`} download>
                PNG, 2,000+ pixels
              </a>
            </div>
            <p className="field-hint campaign-link-hint">
              Print it at least 2 cm (¾ inch) across, with the white border kept. On a sign read from the street,
              make it about a tenth of the distance people will stand from it.
            </p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Scans</h2>
          <span className="panel-sub">Last {DAYS} days</span>
        </div>
        {stats.allTime === 0 ? (
          <div className="empty">
            <p className="empty-title">No scans yet</p>
            <p>Scan the code with your own phone to check it opens the right page. It will show up here.</p>
          </div>
        ) : !stats.hasScansInWindow ? (
          <div className="empty">
            <p>
              No scans in the last {DAYS} days, {stats.allTime.toLocaleString("en-US")} before that.
            </p>
          </div>
        ) : (
          <>
            <div className="panel-body">
              <p className="campaign-total">
                <strong>{stats.total.toLocaleString("en-US")}</strong>{" "}
                {stats.total === 1 ? "scan" : "scans"} in the last {DAYS} days ·{" "}
                {stats.allTime.toLocaleString("en-US")} since {formatDateWithYear(campaign.createdAt)}
              </p>
              <ScanChart series={stats.series} label={`Scans per day, ${campaign.name}`} />
            </div>
            <div className="panel-split panel-split-2">
              <div>
                <h3>What they scanned with</h3>
                <BarList rows={stats.byDevice} unit="scans" />
              </div>
              <div>
                <h3>Where they were</h3>
                <BarList rows={stats.byTown} unit="scans" />
              </div>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Settings</h2>
        </div>
        <div className="panel-body">
          <EditCampaignForm
            publicId={campaign.publicId}
            name={campaign.name}
            destinationPath={campaign.destinationPath}
            readOnly={ctx.impersonating}
          />
          <h3>Counting</h3>
          <p className="panel-note">
            Pausing stops the count, never the code: anyone who scans it still reaches your page.
          </p>
          <PauseCampaignButton publicId={campaign.publicId} paused={campaign.paused} readOnly={ctx.impersonating} />
        </div>
      </section>
    </main>
  );
}
