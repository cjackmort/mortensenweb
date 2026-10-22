import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { listSites } from "@/db/repositories/client/change-requests";
import { listAssets } from "@/db/repositories/client/media-assets";
import { MAX_SHOWCASE_PHOTOS } from "@/db/repositories/client/showcases";
import { NewShowcaseForm } from "./new-showcase-form";
import "../showcase.css";

/**
 * Step one: the photos and a few words. The portal drafts the rest, and the
 * next page is where the client reads and approves it.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Show off a job",
  robots: { index: false, follow: false },
};

/** The newest photos. The library is where you browse; this is for a recent job. */
const PICKER_LIMIT = 120;

export default async function NewShowcasePage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "showcase"))) redirect("/dashboard/growth?locked=showcase#showcase");

  const [assets, sites] = await Promise.all([
    listAssets(db, ctx, { limit: PICKER_LIMIT }),
    listSites(db, ctx),
  ]);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Show off a job</h1>
        <span>
          <Link href="/dashboard/growth/showcase">Job showcase</Link>
        </span>
      </div>

      <NewShowcaseForm
        readOnly={ctx.impersonating}
        maxPhotos={MAX_SHOWCASE_PHOTOS}
        sites={sites.map((s) => ({ publicId: s.publicId, name: s.name }))}
        photos={assets
          // A failed upload can never be used; one still processing will be
          // in a moment, so it is shown, greyed, rather than hidden.
          .filter((a) => a.status === "ready" || a.status === "processing")
          .map((a) => ({
            publicId: a.publicId,
            title: a.title ?? a.originalFilename,
            ready: a.status === "ready",
            hasThumbnail: a.hasThumbnail,
          }))}
      />
    </main>
  );
}
