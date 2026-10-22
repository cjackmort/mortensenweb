import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { addDays, durationDays } from "@/db/repositories/client/ads";
import { businessDate } from "@/lib/billing/period";
import { creativeProblems } from "@/lib/ads/creative";
import { AdSteps } from "@/components/ads/steps";
import { loadCampaignPage } from "../../load";
import { ChannelPicker } from "./channel-picker";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Where your ad runs", robots: { index: false, follow: false } };

/** Days between today and the suggested first day: room for us to check it. */
const DEFAULT_LEAD_DAYS = 3;

/** Step 2: channels, budgets and dates. */
export default async function AdChannelsPage({ params }: { params: Promise<{ publicId: string }> }) {
  const user = await currentUser();
  const { publicId } = await params;
  const { campaign, readOnly } = await loadCampaignPage(user, publicId);
  if (campaign.status !== "draft") redirect(`/dashboard/growth/ads/${publicId}`);
  // The words come first: a campaign with no valid ad has nothing to budget for.
  if (creativeProblems(campaign).length > 0) redirect(`/dashboard/growth/ads/${publicId}/edit`);

  const today = businessDate();
  const days = durationDays(campaign.startsOn, campaign.endsOn) ?? 30;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <Link href="/dashboard/growth/ads">All ads</Link>
        </span>
      </div>

      <AdSteps campaign={publicId} current="channels" />

      <section className="card">
        <ChannelPicker
          campaign={publicId}
          readOnly={readOnly}
          initial={{
            channels: campaign.channels.map((c) => ({ channel: c.channel, budgetCents: c.budgetCents })),
            days,
            startsOn:
              campaign.startsOn && campaign.startsOn > today ? campaign.startsOn : addDays(today, DEFAULT_LEAD_DAYS),
            earliest: addDays(today, 1),
          }}
        />
      </section>
    </main>
  );
}
