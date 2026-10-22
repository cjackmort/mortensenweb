import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { adChannel, feeTermsLabel, type AdChannelKey } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { getAdminCampaign, type AdminCampaignDetail } from "@/db/repositories/admin/ads";
import { previewSettlement } from "@/db/repositories/admin/ad-refund";
import { getCampaignResults } from "@/db/repositories/client/ad-report";
import { googleAdsConfigured } from "@/lib/ads/google-ads";
import { metaConfigured } from "@/lib/ads/meta";
import { campaignDates, durationDays } from "@/lib/ads/dates";
import { CALLS_TO_ACTION } from "@/lib/ads/creative";
import { formatDateTime } from "@/lib/time";
import { AdPreview } from "@/components/ads/ad-preview";
import { AdResults } from "@/components/ads/ad-results";
import type { DailyMetric } from "@/components/ads/daily-chart";
import { CampaignStatusPill } from "@/components/ads/status";
import { formatCents } from "@/components/ads/checkout-lines";
import { ChannelLinkForm, GoLiveButton, ReviewForm, SettleForm, StateButton, SyncButton } from "../forms";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Ad campaign", robots: { index: false, follow: false } };

/** What to build in each platform's own screens, in manual mode. */
function setupSteps(campaign: AdminCampaignDetail, channel: AdChannelKey, budgetCents: number): string[] {
  const days = durationDays(campaign.startsOn, campaign.endsOn) ?? 30;
  const daily = formatCents(Math.floor(budgetCents / days));
  const where = campaign.targetAreas.join(", ") || "the client's area";
  const dates = campaignDates(campaign) ?? "the campaign dates";
  const total = formatCents(budgetCents);

  switch (channel) {
    case "google_search":
      return [
        `Search campaign in the client's account, ${daily} a day (${total} in all), ${dates}.`,
        `Locations: ${where}. One responsive search ad with the headlines and descriptions below.`,
        campaign.phone ? `Call asset: ${campaign.phone}.` : "No phone: skip the call asset.",
      ];
    case "google_maps":
      return [
        `Link the client's Business Profile as a location asset; Maps placements come from it.`,
        `${daily} a day (${total} in all), ${dates}, locations: ${where}.`,
      ];
    case "youtube_display":
      return [`Demand Gen or Display campaign with the photo and headlines, ${daily} a day (${total} in all), ${dates}.`, `Locations: ${where}.`];
    case "facebook":
    case "instagram":
      return [
        `In Ads Manager: one campaign for this client, an ad set with placements limited to ${adChannel(channel).name}.`,
        `Lifetime budget ${total}, scheduled ${dates}, locations: ${where}. Paste the ad set id.`,
      ];
  }
}

export default async function AdminAdCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ metric?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const { publicId } = await params;
  const ctx = adminContextFrom(user);
  const db = await getDb();

  let campaign: AdminCampaignDetail;
  try {
    campaign = await getAdminCampaign(ctx, db, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const asked = (await searchParams).metric;
  const metric: DailyMetric = asked === "impressions" || asked === "spend" ? asked : "clicks";
  // The client's own report, read the way "view as client" reads it.
  const results = campaign.launchedAt
    ? await getCampaignResults(db, tenantContextFrom(user, campaign.organizationId), publicId)
    : null;

  const settling = (campaign.status === "ended" || campaign.status === "cancelled") && campaign.paidAt && !campaign.settledAt;
  const settlement = settling ? await previewSettlement(ctx, db, publicId) : null;
  const manual = campaign.channels.some((c) => c.launchMode !== "api");
  const syncable = campaign.channels.some(
    (c) => c.externalCampaignId && (c.platform === "google_ads" ? googleAdsConfigured() : metaConfigured()),
  );
  const launching = campaign.status === "approved" || campaign.status === "active" || campaign.status === "paused";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <Link href={`/admin/clients/${campaign.clientPublicId}`}>{campaign.clientName}</Link> ·{" "}
          <Link href="/admin/ads">All ads</Link>
        </span>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Where it stands</h2>
          <CampaignStatusPill status={campaign.status} />
        </div>
        <dl className="detail-grid">
          <dt>Paid</dt>
          <dd>
            {campaign.paidAt ? formatDateTime(campaign.paidAt) : "Not yet"}
            {campaign.payment ? ` · ref ${campaign.payment.reference}` : ""}
          </dd>
          <dt>Budget</dt>
          <dd>
            {formatCents(campaign.spendBudgetCents)} ad spend + {formatCents(campaign.managementFeeCents)} fee (
            {feeTermsLabel({ basisPoints: campaign.feeBasisPoints ?? 1500, minimumCents: campaign.feeMinimumCents ?? 2500 })})
          </dd>
          <dt>Dates</dt>
          <dd>{campaignDates(campaign) ?? "—"}</dd>
          <dt>Shown in</dt>
          <dd>{campaign.targetAreas.join(", ") || "—"}</dd>
          {campaign.refundedCents > 0 && (
            <>
              <dt>Refunded</dt>
              <dd>
                {formatCents(campaign.refundedCents)}
                {campaign.refundReference ? ` (${campaign.refundReference})` : ""}
              </dd>
            </>
          )}
        </dl>
        {campaign.reviewNote && (
          <blockquote className="ad-review-note">Sent back: {campaign.reviewNote}</blockquote>
        )}

        <div className="ad-admin-buttons">
          {(campaign.status === "active") && <StateButton campaign={publicId} change="pause" manual={manual} />}
          {campaign.status === "paused" && <StateButton campaign={publicId} change="resume" manual={manual} />}
          {(campaign.status === "active" || campaign.status === "paused") && (
            <StateButton campaign={publicId} change="end" manual={manual} />
          )}
          {(campaign.status === "pending_review" || campaign.status === "approved" || campaign.status === "rejected") && (
            <StateButton campaign={publicId} change="cancel" manual={manual} />
          )}
          {campaign.launchedAt && <SyncButton campaign={publicId} disabled={!syncable} />}
        </div>
      </section>

      {(campaign.status === "pending_review" || campaign.status === "rejected") && (
        <section className="card">
          <h2>Policy check</h2>
          {campaign.policy.problems.length > 0 ? (
            <div className="notice notice-warning">
              <ul>
                {campaign.policy.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="notice notice-success">Keeps Google&rsquo;s editorial rules: lengths, punctuation, capitals, no phone number in the text.</p>
          )}
          {campaign.policy.claims.length > 0 ? (
            <p className="notice notice-warning">
              Claims the business information doesn&rsquo;t make: <strong>{campaign.policy.claims.join(", ")}</strong>.
              Confirm them with the client or send the ad back.
            </p>
          ) : (
            <p className="muted">Every claim in the ad is in the business information.</p>
          )}
          <p className="field-hint">
            Still yours to check by eye: the landing page loads and matches the ad, and the service isn&rsquo;t in a
            restricted category (financial, health, legal, housing need extra steps on both platforms).
          </p>
          {campaign.status === "pending_review" && <ReviewForm campaign={publicId} />}
        </section>
      )}

      <div className="ad-checkout">
        <section className="card">
          <h2>The ad</h2>
          <AdPreview
            businessName={campaign.profile.businessName || campaign.clientName}
            headlines={campaign.headlines}
            descriptions={campaign.descriptions}
            finalUrl={campaign.finalUrl}
            callToAction={campaign.callToAction}
            imageUrl={campaign.imageAssetPublicId ? `/api/media/assets/${campaign.imageAssetPublicId}/preview` : null}
          />
        </section>
        <section className="card">
          <h2>Copy to paste</h2>
          <ol className="ad-copy-list">
            {campaign.headlines.map((h) => (
              <li key={`h-${h}`}>
                <span className="muted">Headline</span> {h}
              </li>
            ))}
            {campaign.descriptions.map((d) => (
              <li key={`d-${d}`}>
                <span className="muted">Description</span> {d}
              </li>
            ))}
          </ol>
          <dl className="detail-grid">
            <dt>Button</dt>
            <dd>{campaign.callToAction ? CALLS_TO_ACTION[campaign.callToAction] : "—"}</dd>
            <dt>Landing page</dt>
            <dd>{campaign.finalUrl ?? "—"}</dd>
            <dt>Phone</dt>
            <dd>{campaign.phone ?? "—"}</dd>
          </dl>
        </section>
      </div>

      {launching && (
        <section className="card">
          <h2>{campaign.status === "approved" ? "Launch" : "Channels"}</h2>
          <div className="ad-admin-channels">
            {campaign.channels.map((c) => (
              <div key={c.channel} className="ad-admin-channel">
                <div className="card-head">
                  <h3>{adChannel(c.channel).name}</h3>
                  <span className="muted">{formatCents(c.budgetCents)}</span>
                </div>
                {campaign.status === "approved" && (
                  <ul className="ad-admin-steps">
                    {setupSteps(campaign, c.channel, c.budgetCents).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                )}
                <ChannelLinkForm
                  campaign={publicId}
                  channel={c.channel}
                  platform={c.platform}
                  accountId={c.externalAccountId}
                  campaignId={c.externalCampaignId}
                />
                {c.lastSyncedAt && <p className="field-hint">Synced {formatDateTime(c.lastSyncedAt)} · {formatCents(Math.round(c.spendMicros / 10_000))} spent</p>}
                {c.syncError && <p className="error">Sync: {c.syncError}</p>}
              </div>
            ))}
          </div>
          {campaign.status === "approved" && (
            <GoLiveButton campaign={publicId} ready={campaign.channels.every((c) => c.externalCampaignId)} />
          )}
        </section>
      )}

      {results && <AdResults results={results} metric={metric} hrefFor={(m) => `/admin/ads/${publicId}?metric=${m}`} />}

      {settling && (
        <section className="card">
          <h2>Settle</h2>
          {settlement ? (
            <dl className="detail-grid">
              <dt>Ad spend kept</dt>
              <dd>{formatCents(settlement.settlement.keptSpendCents)}</dd>
              <dt>Fee kept</dt>
              <dd>{formatCents(settlement.settlement.keptFeeCents)}</dd>
              <dt>Refund</dt>
              <dd>
                <strong>{formatCents(settlement.settlement.refundCents - campaign.refundedCents)}</strong>
              </dd>
            </dl>
          ) : (
            <p className="muted">
              Not every channel has synced its spend, so enter the final figure from Google Ads and Meta. The refund
              and the fee are worked out from it.
            </p>
          )}
          <SettleForm
            campaign={publicId}
            needsFinalSpend={!settlement}
            byHand={campaign.payment?.provider !== "stripe"}
            refundLabel={
              settlement
                ? `${formatCents(settlement.settlement.refundCents - campaign.refundedCents)} goes back to the client.`
                : "The refund is worked out from the spend you enter."
            }
          />
        </section>
      )}
    </main>
  );
}
