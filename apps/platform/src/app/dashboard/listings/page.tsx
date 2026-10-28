import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listListingChecklists } from "@/db/repositories/client/listings";
import { ListingChecklist } from "@/components/listing-checklist";
import { ListingProgressLine } from "@/components/listing-progress";
import { LISTING_CONSISTENCY_NOTE } from "@/lib/listings/steps";
import { markListingStepAction } from "./actions";

/**
 * Get listed: where the client's website is listed, and where it is not yet.
 *
 * A website that is live is not yet findable. Google, Apple, Bing and the
 * directories each have to be told it exists, and each one is a separate
 * account to claim. This page is the one list of those, shared with the
 * operator's view of the client so the two sides tick the same boxes.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get listed",
  robots: { index: false, follow: false },
};

export default async function ListingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const checklists = await listListingChecklists(db, ctx);
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Get listed</h1>
        <span>The places your business needs to be listed, so people find the website</span>
      </div>

      <p className="notice notice-info">{LISTING_CONSISTENCY_NOTE}</p>

      {checklists.length === 0 && (
        <section className="panel">
          <div className="panel-body">
            <p>This list is for your website, and there is no website on your account yet. It appears here once there is.</p>
          </div>
        </section>
      )}

      {checklists.map((checklist) => (
        <section className="panel" key={checklist.sitePublicId} aria-labelledby={`listings-${checklist.sitePublicId}`}>
          <div className="panel-head">
            <h2 id={`listings-${checklist.sitePublicId}`}>{checklist.siteName}</h2>
            <span className="panel-sub">
              {checklist.progress.done === checklist.progress.total
                ? "All listed"
                : "We do most of these for you; tick anything you have done yourself"}
            </span>
          </div>
          <div className="panel-body">
            <ListingProgressLine progress={checklist.progress} />
            <ListingChecklist
              checklist={checklist}
              action={markListingStepAction}
              hidden={{}}
              readOnly={readOnly}
              viewerUserId={ctx.userId}
            />
          </div>
        </section>
      ))}
    </main>
  );
}
