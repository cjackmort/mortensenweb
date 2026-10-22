import Link from "next/link";
import { redirect } from "next/navigation";
import { AD_MANAGEMENT_FEE, ADS_AVAILABLE } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { durationDays } from "@/db/repositories/client/ads";
import { creativeProblems } from "@/lib/ads/creative";
import { checkoutLines, validateBudgets } from "@/lib/ads/money";
import { stripeConfigured } from "@/lib/payments/stripe";
import { AdSteps } from "@/components/ads/steps";
import { AdPreview } from "@/components/ads/ad-preview";
import { CampaignSummary } from "@/components/ads/campaign-summary";
import { formatCents } from "@/components/ads/checkout-lines";
import { loadCampaignPage } from "../../load";
import { PayButton } from "../pay-buttons";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Pay for your ad", robots: { index: false, follow: false } };

/**
 * Step 3: everything the client is agreeing to, on one screen, before Stripe.
 *
 * The ad as it will look, where and when it runs, and the bill with the
 * management fee as a line of its own. What happens to unspent budget is said
 * here, before they pay, rather than discovered at the end.
 */
export default async function AdCheckoutPage({ params }: { params: Promise<{ publicId: string }> }) {
  const user = await currentUser();
  const { publicId } = await params;
  const { campaign, businessName, readOnly } = await loadCampaignPage(user, publicId);
  if (campaign.status !== "draft") redirect(`/dashboard/growth/ads/${publicId}`);

  const days = durationDays(campaign.startsOn, campaign.endsOn) ?? 0;
  const channels = campaign.channels.map((c) => ({ channel: c.channel, budgetCents: c.budgetCents }));
  if (creativeProblems(campaign).length > 0) redirect(`/dashboard/growth/ads/${publicId}/edit`);
  if (!validateBudgets(channels, days).ok) redirect(`/dashboard/growth/ads/${publicId}/channels`);

  const total = checkoutLines({ channels, terms: AD_MANAGEMENT_FEE }).totalCents;
  const cardsReady = stripeConfigured();

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <Link href="/dashboard/growth/ads">All ads</Link>
        </span>
      </div>

      <AdSteps campaign={publicId} current="checkout" />

      <div className="ad-checkout">
        <section className="card">
          <h2>Your ad</h2>
          <AdPreview
            businessName={businessName}
            headlines={campaign.headlines}
            descriptions={campaign.descriptions}
            finalUrl={campaign.finalUrl}
            callToAction={campaign.callToAction}
            imageUrl={campaign.imageAssetPublicId ? `/api/media/assets/${campaign.imageAssetPublicId}/preview` : null}
          />
          <p>
            <Link href={`/dashboard/growth/ads/${publicId}/edit`}>Change the ad</Link>
          </p>
        </section>

        <section className="card">
          <h2>Where, when and how much</h2>
          <CampaignSummary campaign={campaign} terms={AD_MANAGEMENT_FEE} />
          <p>
            <Link href={`/dashboard/growth/ads/${publicId}/channels`}>Change where it runs</Link>
          </p>

          <h3>What happens next</h3>
          <ol className="ad-next">
            <li>You pay by card on Stripe&rsquo;s secure page.</li>
            <li>We check the ad against Google&rsquo;s and Meta&rsquo;s rules. If something has to change, we tell you why.</li>
            <li>We set it up and it starts. You watch how it does here, including where it was seen.</li>
          </ol>

          {!cardsReady && (
            <p className="notice notice-warning">
              Card payments aren&rsquo;t switched on for your account yet.{" "}
              <Link href="/dashboard/requests">Send us a request</Link> and we&rsquo;ll set this ad up with you.
            </p>
          )}
          {!ADS_AVAILABLE && (
            <p className="notice notice-info">Ads are almost ready. Paying switches on here the day they are.</p>
          )}

          <PayButton
            campaign={publicId}
            label={`Pay ${formatCents(total)}`}
            disabled={readOnly || !cardsReady || !ADS_AVAILABLE}
          />
        </section>
      </div>
    </main>
  );
}
