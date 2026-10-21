import Link from "next/link";
import { redirect } from "next/navigation";
import { AD_MANAGEMENT_FEE } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { AdPreview } from "@/components/ads/ad-preview";
import { CampaignSummary } from "@/components/ads/campaign-summary";
import { CampaignStatusPill, statusExplainer } from "@/components/ads/status";
import { AdResults } from "@/components/ads/ad-results";
import type { DailyMetric } from "@/components/ads/daily-chart";
import { getCampaignResults } from "@/db/repositories/client/ad-report";
import { formatCents } from "@/components/ads/checkout-lines";
import { loadCampaignPage } from "../load";
import { ReopenButton } from "./pay-buttons";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Ad campaign", robots: { index: false, follow: false } };

const METRICS: DailyMetric[] = ["clicks", "impressions", "spend"];

/**
 * One campaign, after the client has finished creating it: how it is doing
 * and where it was seen, where it stands, what was agreed, and the ad itself.
 * A draft goes back to the editor.
 */
export default async function AdCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ paid?: string; metric?: string }>;
}) {
  const user = await currentUser();
  const { publicId } = await params;
  const { ctx, db, campaign, businessName, readOnly } = await loadCampaignPage(user, publicId);
  if (campaign.status === "draft") redirect(`/dashboard/growth/ads/${publicId}/edit`);

  const { paid, metric: asked } = await searchParams;
  const metric = METRICS.find((m) => m === asked) ?? "clicks";
  const results = campaign.launchedAt ? await getCampaignResults(db, ctx, publicId) : null;
  const terms =
    campaign.feeBasisPoints !== null && campaign.feeMinimumCents !== null
      ? { basisPoints: campaign.feeBasisPoints, minimumCents: campaign.feeMinimumCents }
      : AD_MANAGEMENT_FEE;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <Link href="/dashboard/growth/ads">All ads</Link>
        </span>
      </div>

      {paid && campaign.status === "awaiting_payment" && (
        <p className="notice notice-info" role="status">
          Thanks. Your payment is going through and this page updates when it lands, usually within a minute.
        </p>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Where it stands</h2>
          <CampaignStatusPill status={campaign.status} />
        </div>
        <p>{statusExplainer(campaign.status)}</p>
        {campaign.status === "rejected" && campaign.reviewNote && (
          <blockquote className="ad-review-note">{campaign.reviewNote}</blockquote>
        )}
        {campaign.status === "awaiting_payment" && <ReopenButton campaign={publicId} disabled={readOnly} />}
        {campaign.status === "rejected" && !readOnly && (
          <Link className="button" href={`/dashboard/growth/ads/${publicId}/edit`}>
            Change the ad
          </Link>
        )}
        {campaign.refundedCents > 0 && (
          <p className="notice notice-success">
            {formatCents(campaign.refundedCents)} has been refunded to your card.
          </p>
        )}
      </section>

      {results && (
        <AdResults
          results={results}
          metric={metric}
          hrefFor={(m) => `/dashboard/growth/ads/${publicId}${m === "clicks" ? "" : `?metric=${m}`}`}
        />
      )}

      <div className="ad-checkout">
        <section className="card">
          <h2>The ad</h2>
          <AdPreview
            businessName={businessName}
            headlines={campaign.headlines}
            descriptions={campaign.descriptions}
            finalUrl={campaign.finalUrl}
            callToAction={campaign.callToAction}
            imageUrl={campaign.imageAssetPublicId ? `/api/media/assets/${campaign.imageAssetPublicId}/preview` : null}
          />
        </section>
        <section className="card">
          <h2>Where, when and how much</h2>
          <CampaignSummary campaign={campaign} terms={terms} />
        </section>
      </div>
    </main>
  );
}
