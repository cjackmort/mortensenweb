import { AD_UNSPENT_POLICY, adChannel, type AdFeeTerms } from "@mortensenweb/plans";
import type { CampaignDetail } from "@/db/repositories/client/ads";
import { checkoutLines } from "@/lib/ads/money";
import { campaignDates } from "@/lib/ads/dates";
import { CheckoutLinesTable } from "./checkout-lines";

export { campaignDates };

/**
 * Where, when and for how much: the facts the client agreed to, for the
 * checkout page and the campaign page alike. A paid campaign is billed at the
 * terms it was sold at, so those are what it shows.
 */
export function CampaignSummary({ campaign, terms }: { campaign: CampaignDetail; terms: AdFeeTerms }) {
  const lines = checkoutLines({
    channels: campaign.channels.map((c) => ({ channel: c.channel, budgetCents: c.budgetCents })),
    terms,
  });
  const dates = campaignDates(campaign);

  return (
    <div className="ad-summary">
      <dl className="detail-grid">
        <dt>Where</dt>
        <dd>{campaign.channels.map((c) => adChannel(c.channel).name).join(", ") || "Not chosen yet"}</dd>
        <dt>When</dt>
        <dd>{dates ?? "Not chosen yet"}</dd>
        <dt>Shown to people in</dt>
        <dd>{campaign.targetAreas.join(", ") || "Not chosen yet"}</dd>
      </dl>
      <CheckoutLinesTable lines={lines} caption="What you pay" />
      <p className="field-hint">{AD_UNSPENT_POLICY}</p>
    </div>
  );
}
