import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { listFolders } from "@/db/repositories/client/media-folders";
import {
  getStorageUsage,
  listAssets,
} from "@/db/repositories/client/media-assets";
import { MediaLibrary } from "./library";

/**
 * The client's media library.
 *
 * `force-dynamic` for the same reason every other authenticated page here is:
 * this renders one tenant's images, and a cached copy served to another client
 * would be a breach rather than a bug. `next.config.ts` additionally sends
 * `no-store` for everything under `/dashboard`.
 *
 * Filters live in the URL — folder, search, trash. That makes a view something
 * a client can bookmark or send to us in a support conversation, which local
 * component state cannot be.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Media library",
  robots: { index: false, follow: false },
};

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; q?: string; trash?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="page">
        <div className="card">
          <div className="card-head">
            <h2>Media library</h2>
          </div>
          <p className="notice">
            Your account is not linked to an organization yet. Please contact us.
          </p>
        </div>
      </main>
    );
  }

  const params = await searchParams;
  const folder = params.folder?.trim() || null;
  const search = params.q?.trim() ?? "";
  const trashed = params.trash === "1";

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  // Three independent reads, so they go together rather than in series.
  const [folders, assets, usage] = await Promise.all([
    listFolders(db, ctx),
    listAssets(db, ctx, {
      /*
       * `undefined` means everywhere; a string narrows to one folder.
       *
       * With no folder selected this is deliberately *everywhere* rather than
       * "images with no folder". The view is called "All images", and a client
       * who files a photo into a folder and then cannot find it under All
       * images would reasonably conclude we had lost it. Unfiling is still
       * available — it is the "All images (no folder)" destination in the move
       * menu — but that is a place to put something, not a filter.
       */
      folderPublicId: folder ?? undefined,
      search,
      trashed,
    }),
    getStorageUsage(db, ctx),
  ]);

  return (
    <main className="page">
      <div className="page-intro">
        <h1>Media library</h1>
        <p>
          Your photos and artwork, at full quality. Upload once and use them in
          as many change requests as you like.
        </p>
        {/* Said plainly, because a client who suspects that filing a photo
            might rearrange their website will not use folders at all. */}
        <p className="field-hint">
          Folders are for your own organisation. Moving images between them
          never changes your website &mdash; that only happens when you ask for
          a change and approve the preview.
        </p>
      </div>

      <MediaLibrary
        folders={folders}
        assets={assets}
        usage={usage}
        currentFolder={trashed ? null : folder}
        search={search}
        trashed={trashed}
      />
    </main>
  );
}
