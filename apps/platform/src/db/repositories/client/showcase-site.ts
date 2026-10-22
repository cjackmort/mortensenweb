import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { changeRequests, mediaAssets, showcasePhotos, showcases, sites } from "@/db/schema";
import { nudgeScheduler } from "@/lib/scheduler/nudge";
import { siteRequestBrief, type PhotoRole } from "@/lib/showcase/site-brief";
import { BLOCKED_DETAIL, type SiteBlockedReason } from "@/lib/showcase/status";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { createChangeRequest, findOpenRequestForSite } from "./change-requests";
import { consumeChange, getEntitlements, refundChange } from "./entitlements";
import { attachAssetsToRequest, validateAssetSelection } from "./request-assets";

/**
 * Sending a showcase to the client's website, as an ordinary change request.
 *
 * It goes through the same gates, in the same order, as a request typed on
 * the Requests page (`app/dashboard/requests/actions.ts`): change requests
 * unlocked by a first payment, one open change per site, then one change
 * claimed from the month's allowance — claimed last, so a refusal never costs
 * the client a change. The request it opens is `submitted`, so the scheduled
 * dispatcher picks it up, the agent builds a preview, the operator releases it
 * and the client approves it. Nothing here can reach the live site directly.
 *
 * A refusal is recorded on the showcase rather than returned and forgotten,
 * so the showcase list can say why the page is waiting and offer to send it
 * again once whatever blocked it has cleared.
 */

/** A request in one of these is finished without the page going live. */
const STOPPED = new Set(["closed", "rejected", "rolled_back"]);

export type SendResult =
  | { ok: true; message: string }
  | { ok: false; reason: SiteBlockedReason | "not_approved" | "already_sent"; message: string };

async function block(db: Database, showcaseId: string, reason: SiteBlockedReason): Promise<SendResult> {
  await db
    .update(showcases)
    .set({ siteBlockedReason: reason, updatedAt: new Date() })
    .where(eq(showcases.id, showcaseId));
  return { ok: false, reason, message: BLOCKED_DETAIL[reason] };
}

export async function sendShowcaseToSite(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<SendResult> {
  assertMutable(ctx);

  const [row] = await db
    .select({
      id: showcases.id,
      status: showcases.status,
      title: showcases.title,
      writeUp: showcases.writeUp,
      town: showcases.town,
      siteRequestId: showcases.siteRequestId,
      sitePublicId: sites.publicId,
    })
    .from(showcases)
    .leftJoin(sites, eq(sites.id, showcases.siteId))
    .where(and(eq(showcases.publicId, publicId), eq(showcases.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();

  if (row.status !== "approved") {
    return { ok: false, reason: "not_approved", message: "Approve the write-up first." };
  }

  // A page already on its way is not sent twice. One that was stopped can be.
  let previous: string | null = null;
  if (row.siteRequestId) {
    const [request] = await db
      .select({ publicId: changeRequests.publicId, status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.id, row.siteRequestId))
      .limit(1);
    if (request && !STOPPED.has(request.status)) {
      return { ok: false, reason: "already_sent", message: "It's already been sent to your website." };
    }
    previous = request?.publicId ?? null;
  }

  if (!row.sitePublicId) return block(db, row.id, "no_site");

  const photos = await db
    .select({ assetPublicId: mediaAssets.publicId, role: showcasePhotos.role })
    .from(showcasePhotos)
    .innerJoin(mediaAssets, eq(mediaAssets.id, showcasePhotos.assetId))
    .where(and(eq(showcasePhotos.showcaseId, row.id), isNull(mediaAssets.deletedAt)))
    .orderBy(asc(showcasePhotos.position));
  const assetIds = photos.map((p) => p.assetPublicId);
  const selection = await validateAssetSelection(db, ctx, assetIds);
  if (assetIds.length === 0 || !selection.ok) return block(db, row.id, "photos_not_ready");

  const entitlements = await getEntitlements(db, ctx);
  if (entitlements && !entitlements.changeRequestsUnlocked) return block(db, row.id, "locked");

  if (await findOpenRequestForSite(db, ctx, row.sitePublicId)) return block(db, row.id, "one_at_a_time");

  const claim = await consumeChange(db, ctx);
  if (!claim.ok) return block(db, row.id, claim.reason === "exhausted" ? "allowance_exhausted" : "failed");

  const brief = siteRequestBrief(row, photos.map((p) => ({ role: p.role as PhotoRole })));
  let created;
  try {
    created = await createChangeRequest(db, ctx, {
      title: brief.title,
      description: brief.description,
      category: "content",
      sitePublicId: row.sitePublicId,
      allowanceId: claim.allowanceId,
      // One request per showcase per attempt: a retry of the same send finds
      // the request it already made, while sending again after a stopped one
      // gets a fresh key.
      idempotencyKey: previous ? `showcase:${publicId}:after:${previous}` : `showcase:${publicId}`,
    });
  } catch (error) {
    await refundChange(db, claim.allowanceId);
    console.error("[showcase] change request failed", {
      showcase: publicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return block(db, row.id, "failed");
  }

  if (created.duplicate) {
    await refundChange(db, claim.allowanceId);
  } else {
    const attached = await attachAssetsToRequest(db, ctx, created.id, assetIds);
    if (!attached.ok) {
      // The request exists and the brief describes the photos; the operator
      // sees it before anything ships. Logged so a missing photo is traceable.
      console.warn("[showcase] photos not attached", { showcase: publicId, message: attached.message });
    }
  }

  await db
    .update(showcases)
    .set({ siteRequestId: created.id, siteBlockedReason: null, updatedAt: new Date() })
    .where(eq(showcases.id, row.id));

  nudgeScheduler("showcase sent to site");
  return { ok: true, message: "Sent. We'll make the page and show you a preview before it goes live." };
}
