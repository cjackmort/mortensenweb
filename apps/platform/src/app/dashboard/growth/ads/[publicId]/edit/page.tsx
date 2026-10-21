import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { listAdImages } from "@/db/repositories/client/ads";
import { AdSteps } from "@/components/ads/steps";
import { loadCampaignPage } from "../../load";
import { discardAdAction } from "../../actions";
import { CreativeEditor } from "./creative-editor";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your ad", robots: { index: false, follow: false } };

const MISSING_LABEL: Record<string, string> = {
  businessName: "your business name",
  services: "your services",
  serviceArea: "the areas you serve",
  phone: "your phone number",
  website: "your website",
};

/**
 * Step 1: the words, the photo and where a click goes.
 *
 * Arrives pre-filled from "Create ad". When the draft was thin because the
 * business information is, the page says which details would have helped —
 * and that we add them, because those details are published on the client's
 * site and are an operator's to change.
 */
export default async function EditAdPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ missing?: string }>;
}) {
  const user = await currentUser();
  const { publicId } = await params;
  const { ctx, db, campaign, businessName, readOnly } = await loadCampaignPage(user, publicId);
  if (campaign.status !== "draft") redirect(`/dashboard/growth/ads/${publicId}`);

  const images = await listAdImages(db, ctx);
  const missing = ((await searchParams).missing ?? "")
    .split(",")
    .map((key) => MISSING_LABEL[key])
    .filter(Boolean);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{campaign.name}</h1>
        <span>
          <Link href="/dashboard/growth/ads">All ads</Link>
        </span>
      </div>

      <AdSteps campaign={publicId} current="edit" />

      {missing.length > 0 && (
        <p className="notice notice-info">
          We wrote this from your business information, which doesn&rsquo;t include {missing.join(", ")} yet.{" "}
          <Link href="/dashboard/requests">Send us those</Link> and future drafts will use them.
        </p>
      )}

      <section className="card">
        <CreativeEditor
          campaign={publicId}
          businessName={businessName}
          initial={campaign}
          facts={campaign.draftFacts ?? {}}
          images={images}
          readOnly={readOnly}
        />
      </section>

      {!readOnly && (
        <form action={discardAdAction} className="ad-discard">
          <input type="hidden" name="campaign" value={publicId} />
          <button type="submit" className="linklike">
            Delete this draft
          </button>
        </form>
      )}
    </main>
  );
}
