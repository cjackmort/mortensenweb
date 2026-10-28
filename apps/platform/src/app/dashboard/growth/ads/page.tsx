import Link from "next/link";
import { BackToGrowth } from "@/components/back-link";
import { redirect } from "next/navigation";
import { ADS_AVAILABLE, AD_CHANNELS, AD_UNSPENT_POLICY, adChannel, feeTermsLabel } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listCampaigns } from "@/db/repositories/client/ads";
import { CampaignStatusPill } from "@/components/ads/status";
import { CreateAdButton } from "@/components/ads/create-ad-button";
import { campaignDates } from "@/components/ads/campaign-summary";
import { formatCents } from "@/components/ads/checkout-lines";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Ads", robots: { index: false, follow: false } };

/**
 * The client's ads: every campaign, newest first, and the way to make a new
 * one. On every plan — the client pays per campaign — so there is no lock
 * here, only the switch that keeps it dark until ads can actually be run.
 */
export default async function AdsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const campaigns = ADS_AVAILABLE ? await listCampaigns(await getDb(), ctx) : [];

  return (
    <main className="shell">
      <BackToGrowth />
      <div className="masthead">
        <h1>Ads</h1>
        <span>
          <Link href="/dashboard/growth">Growth</Link>
        </span>
      </div>

      <section className="card ad-intro">
        <div>
          <h2>Ads on Google, Facebook and Instagram</h2>
          <p>
            We write a first draft from your business information. You change anything you like, choose where it runs
            and how much to spend, and pay once for the campaign.
          </p>
          <ul className="ad-intro-points">
            <li>
              <strong>Ad spend</strong> goes to Google or Meta at cost.
            </li>
            <li>
              <strong>Our management fee</strong> is {feeTermsLabel()}, always shown as its own line.
            </li>
            <li>{AD_UNSPENT_POLICY}</li>
          </ul>
          {ADS_AVAILABLE && !ctx.impersonating ? (
            <CreateAdButton />
          ) : (
            <p className="notice notice-info">
              {ADS_AVAILABLE ? "Viewing as the client: read only." : "Ads are almost ready. This switches on the day they are."}
            </p>
          )}
        </div>
        <ul className="ad-intro-channels" aria-label="Where ads can run">
          {AD_CHANNELS.map((c) => (
            <li key={c.key}>
              <strong>{c.name}</strong>
              <span>{c.summary}</span>
            </li>
          ))}
        </ul>
      </section>

      {campaigns.length > 0 && (
        <section className="card">
          <h2>Your campaigns</h2>
          <ul className="ad-list">
            {campaigns.map((c) => (
              <li key={c.publicId}>
                <Link href={`/dashboard/growth/ads/${c.publicId}`} className="ad-list-row">
                  <span className="ad-list-name">
                    <strong>{c.name}</strong>
                    <small>
                      {c.channels.map((key) => adChannel(key).name).join(", ") || "No channels chosen"}
                      {campaignDates(c) ? ` · ${campaignDates(c)}` : ""}
                    </small>
                  </span>
                  <span className="ad-list-money">
                    {c.spendBudgetCents > 0 ? formatCents(c.spendBudgetCents) : "—"}
                    <small>budget</small>
                  </span>
                  <CampaignStatusPill status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
