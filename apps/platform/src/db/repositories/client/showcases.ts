import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  businessProfiles,
  changeRequests,
  mediaAssets,
  mediaDerivatives,
  organizations,
  showcasePhotos,
  showcases,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { brandColours, type BrandColours } from "@/lib/showcase/brand";
import { draftShowcase, graphicCaption, validateShowcaseWords, validateWording } from "@/lib/showcase/draft";
import {
  googlePostFor,
  googlePostPublisher,
  type GooglePostInput,
  type GooglePostPublisher,
} from "@/lib/showcase/google-post";
import type { PhotoRole } from "@/lib/showcase/site-brief";
import { googleOutput, siteOutput, type GoogleOutput, type SiteOutput } from "@/lib/showcase/status";
import { mediaDriver } from "@/lib/storage/driver";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { validateAssetSelection } from "./request-assets";
import { sendShowcaseToSite } from "./showcase-site";

export { sendShowcaseToSite } from "./showcase-site";

/**
 * Job showcase, tenant-scoped. Every query filters on `ctx.organizationId`,
 * and a public id from another tenant is `NotFoundError`, indistinguishable
 * from one that never existed. Whether the client has the feature at all is
 * checked by the pages and actions, as for the leads inbox.
 */

/** Enough to tell the story of one job; more is a gallery, not a showcase. */
export const MAX_SHOWCASE_PHOTOS = 12;

export interface ShowcasePhoto {
  assetPublicId: string;
  title: string;
  role: PhotoRole;
  /** False when trashed or not ready: shown, but not used. */
  usable: boolean;
}

export interface ShowcaseSummary {
  publicId: string;
  title: string;
  town: string;
  status: "draft" | "approved";
  createdAt: Date;
  approvedAt: Date | null;
  coverAssetPublicId: string | null;
  photoCount: number;
  site: SiteOutput;
  google: GoogleOutput;
  /** Approved, with at least one usable photo. */
  graphicsReady: boolean;
}

export interface ShowcaseDetail extends ShowcaseSummary {
  job: string;
  notes: string | null;
  writeUp: string;
  caption: string;
  photos: ShowcasePhoto[];
  siteName: string | null;
  requestPublicId: string | null;
  googleError: string | null;
  googlePost: GooglePostInput;
  businessName: string;
  brand: BrandColours;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function profileFor(db: Database, ctx: TenantContext): Promise<Record<string, string>> {
  const [row] = await db
    .select({ details: businessProfiles.details })
    .from(businessProfiles)
    .where(eq(businessProfiles.organizationId, ctx.organizationId))
    .limit(1);
  return row?.details ?? {};
}

/** The name on the graphics: General information's, else the account's own. */
async function businessNameFor(db: Database, ctx: TenantContext, profile: Record<string, string>) {
  if (profile.businessName?.trim()) return profile.businessName.trim();
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  return org?.name ?? "";
}

const showcaseColumns = {
  id: showcases.id,
  publicId: showcases.publicId,
  job: showcases.job,
  town: showcases.town,
  notes: showcases.notes,
  title: showcases.title,
  writeUp: showcases.writeUp,
  caption: showcases.caption,
  status: showcases.status,
  createdAt: showcases.createdAt,
  approvedAt: showcases.approvedAt,
  siteRequestId: showcases.siteRequestId,
  siteBlockedReason: showcases.siteBlockedReason,
  googleStatus: showcases.googleStatus,
  googleError: showcases.googleError,
  siteName: sites.name,
};

type ShowcaseRow = Awaited<ReturnType<typeof selectShowcases>>[number];

function selectShowcases(db: Database, ctx: TenantContext, publicId?: string) {
  return db
    .select(showcaseColumns)
    .from(showcases)
    .leftJoin(sites, eq(sites.id, showcases.siteId))
    .where(
      and(
        eq(showcases.organizationId, ctx.organizationId),
        publicId ? eq(showcases.publicId, publicId) : undefined,
      ),
    )
    .orderBy(desc(showcases.createdAt))
    .limit(publicId ? 1 : 100);
}

/** The cover: the "after" of a pair, else the first usable photo. */
function coverOf(photos: ShowcasePhoto[]): string | null {
  const usable = photos.filter((p) => p.usable);
  return (usable.find((p) => p.role === "after") ?? usable[0])?.assetPublicId ?? null;
}

/**
 * Photos, change requests and their latest agent jobs for a set of showcases,
 * in three plain queries rather than correlated subqueries — Drizzle leaves a
 * single-table subquery's columns unqualified, and a self-comparing subquery
 * returns null without an error.
 */
async function hydrate(db: Database, ctx: TenantContext, rows: ShowcaseRow[]) {
  const ids = rows.map((r) => r.id);
  const requestIds = rows.map((r) => r.siteRequestId).filter((id): id is string => id !== null);

  const photoRows = ids.length
    ? await db
        .select({
          showcaseId: showcasePhotos.showcaseId,
          assetPublicId: mediaAssets.publicId,
          title: mediaAssets.title,
          filename: mediaAssets.originalFilename,
          role: showcasePhotos.role,
          status: mediaAssets.status,
          deletedAt: mediaAssets.deletedAt,
        })
        .from(showcasePhotos)
        .innerJoin(mediaAssets, eq(mediaAssets.id, showcasePhotos.assetId))
        .where(and(inArray(showcasePhotos.showcaseId, ids), eq(mediaAssets.organizationId, ctx.organizationId)))
        .orderBy(asc(showcasePhotos.position))
    : [];

  const requestRows = requestIds.length
    ? await db
        .select({ id: changeRequests.id, publicId: changeRequests.publicId, status: changeRequests.status })
        .from(changeRequests)
        .where(and(inArray(changeRequests.id, requestIds), eq(changeRequests.organizationId, ctx.organizationId)))
    : [];

  const jobRows = requestIds.length
    ? await db
        .select({
          requestId: agentJobs.requestId,
          operatorReleasedAt: agentJobs.operatorReleasedAt,
          previewVerifiedAt: agentJobs.previewVerifiedAt,
        })
        .from(agentJobs)
        .where(inArray(agentJobs.requestId, requestIds))
        .orderBy(desc(agentJobs.createdAt))
    : [];

  const latestJob = new Map<string, (typeof jobRows)[number]>();
  for (const job of jobRows) {
    if (job.requestId && !latestJob.has(job.requestId)) latestJob.set(job.requestId, job);
  }

  return rows.map((row) => {
    const photos: ShowcasePhoto[] = photoRows
      .filter((p) => p.showcaseId === row.id)
      .map((p) => ({
        assetPublicId: p.assetPublicId,
        title: p.title?.trim() || p.filename,
        role: p.role as PhotoRole,
        usable: p.deletedAt === null && p.status === "ready",
      }));
    const request = requestRows.find((r) => r.id === row.siteRequestId) ?? null;
    const job = request ? latestJob.get(request.id) : undefined;
    const approved = row.status === "approved";
    const cover = coverOf(photos);

    const summary: ShowcaseSummary = {
      publicId: row.publicId,
      title: row.title,
      town: row.town,
      status: approved ? "approved" : "draft",
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      coverAssetPublicId: cover,
      photoCount: photos.length,
      site: siteOutput({
        approved,
        blockedReason: row.siteBlockedReason,
        request: request
          ? {
              status: request.status,
              // The Requests page's own rule: a preview is offered only once
              // it has answered and the operator has released it.
              previewReleased: Boolean(job?.operatorReleasedAt && job.previewVerifiedAt),
            }
          : null,
      }),
      google: googleOutput(row.googleStatus),
      graphicsReady: approved && cover !== null,
    };
    return { summary, photos, request, row };
  });
}

export async function listShowcases(db: Database, ctx: TenantContext): Promise<ShowcaseSummary[]> {
  const rows = await selectShowcases(db, ctx);
  return (await hydrate(db, ctx, rows)).map((h) => h.summary);
}

export async function getShowcase(db: Database, ctx: TenantContext, publicId: string): Promise<ShowcaseDetail> {
  const rows = await selectShowcases(db, ctx, publicId);
  if (rows.length === 0) throw new NotFoundError();
  const [{ summary, photos, request, row }] = (await hydrate(db, ctx, rows)) as [Awaited<ReturnType<typeof hydrate>>[number]];
  const profile = await profileFor(db, ctx);

  return {
    ...summary,
    job: row.job,
    notes: row.notes,
    writeUp: row.writeUp,
    caption: row.caption,
    photos,
    siteName: row.siteName,
    requestPublicId: request?.publicId ?? null,
    googleError: row.googleError,
    googlePost: googlePostFor({ writeUp: row.writeUp, coverAssetPublicId: summary.coverAssetPublicId }, profile),
    businessName: await businessNameFor(db, ctx, profile),
    brand: brandColours(profile),
  };
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export interface NewShowcaseInput {
  job: string;
  town: string;
  notes?: string | null;
  /** Which site the page goes on. Optional when the client has one. */
  sitePublicId?: string | null;
  /** In the order to show them. */
  photoPublicIds: string[];
  beforePublicId?: string | null;
  afterPublicId?: string | null;
}

export type ShowcaseResult = { ok: true; publicId: string } | { ok: false; message: string };
export type ShowcaseMessage = { ok: true; message: string } | { ok: false; message: string };

function checkPair(ids: string[], before: string | null, after: string | null): string | null {
  if (!before && !after) return null;
  if (!before || !after) return "Pick both a before and an after photo, or neither.";
  if (before === after) return "The before and after need to be different photos.";
  if (!ids.includes(before) || !ids.includes(after)) return "Choose the before and after from the photos you picked.";
  return null;
}

async function resolveSite(
  db: Database,
  ctx: TenantContext,
  sitePublicId: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  const owned = await db
    .select({ id: sites.id, publicId: sites.publicId })
    .from(sites)
    .where(eq(sites.organizationId, ctx.organizationId));
  if (sitePublicId) {
    const site = owned.find((s) => s.publicId === sitePublicId);
    return site ? { ok: true, id: site.id } : { ok: false, message: "We couldn't find that website." };
  }
  if (owned.length > 1) return { ok: false, message: "Choose which website the page goes on." };
  // No site yet is allowed: the graphics and the Google post still work, and
  // the page waits with a reason the client can read.
  return { ok: true, id: owned[0]?.id ?? null };
}

export async function createShowcase(
  db: Database,
  ctx: TenantContext,
  input: NewShowcaseInput,
): Promise<ShowcaseResult> {
  assertMutable(ctx);

  const words = validateShowcaseWords(input);
  if (!words.ok) return words;

  const ids = [...new Set(input.photoPublicIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, message: "Choose at least one photo of the job." };
  if (ids.length > MAX_SHOWCASE_PHOTOS) {
    return { ok: false, message: `Choose up to ${MAX_SHOWCASE_PHOTOS} photos.` };
  }
  const before = input.beforePublicId?.trim() || null;
  const after = input.afterPublicId?.trim() || null;
  const pairProblem = checkPair(ids, before, after);
  if (pairProblem) return { ok: false, message: pairProblem };

  const selection = await validateAssetSelection(db, ctx, ids);
  if (!selection.ok) return { ok: false, message: selection.message };

  const site = await resolveSite(db, ctx, input.sitePublicId?.trim() || null);
  if (!site.ok) return site;

  const draft = draftShowcase({ ...words.words, profile: await profileFor(db, ctx) });
  const publicId = newPublicId();

  const [created] = await db
    .insert(showcases)
    .values({
      publicId,
      organizationId: ctx.organizationId,
      siteId: site.id,
      ...words.words,
      ...draft,
      createdBy: ctx.userId,
    })
    .returning({ id: showcases.id });

  await db.insert(showcasePhotos).values(
    selection.assets.map((asset, position) => ({
      showcaseId: created!.id,
      assetId: asset.id,
      position,
      role: asset.publicId === before ? "before" : asset.publicId === after ? "after" : "photo",
    })),
  );

  return { ok: true, publicId };
}

async function existsFor(db: Database, ctx: TenantContext, publicId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: showcases.id })
    .from(showcases)
    .where(and(eq(showcases.publicId, publicId), eq(showcases.organizationId, ctx.organizationId)))
    .limit(1);
  return Boolean(row);
}

const ALREADY_APPROVED: ShowcaseMessage = {
  ok: false,
  message: "This one is already approved, so the wording is fixed. Start a new showcase to change it.",
};

/** Save edits to a draft. Approved wording is what was published, so it stays. */
export async function saveShowcaseWording(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: { title: unknown; writeUp: unknown; caption: unknown },
): Promise<ShowcaseMessage> {
  assertMutable(ctx);
  const checked = validateWording(input);
  if (!checked.ok) return checked;

  const updated = await db
    .update(showcases)
    .set({ ...checked.wording, updatedAt: new Date() })
    .where(
      and(
        eq(showcases.publicId, publicId),
        eq(showcases.organizationId, ctx.organizationId),
        eq(showcases.status, "draft"),
      ),
    )
    .returning({ id: showcases.id });
  if (updated.length > 0) return { ok: true, message: "Saved." };
  if (await existsFor(db, ctx, publicId)) return ALREADY_APPROVED;
  throw new NotFoundError();
}

// ---------------------------------------------------------------------------
// Approving and publishing
// ---------------------------------------------------------------------------

/**
 * Post to Google where a connection exists; otherwise mark it for posting by
 * hand. A failure is recorded in Google's words and offered as a manual post,
 * never retried silently — a duplicate post is visible on the profile.
 */
export async function publishShowcaseToGoogle(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  publisher: GooglePostPublisher = googlePostPublisher(),
): Promise<void> {
  assertMutable(ctx);
  const detail = await getShowcase(db, ctx, publicId);
  const now = new Date();
  const where = and(eq(showcases.publicId, publicId), eq(showcases.organizationId, ctx.organizationId));

  if (!(await publisher.isConnected(db, ctx.organizationId))) {
    await db.update(showcases).set({ googleStatus: "manual", updatedAt: now }).where(where);
    return;
  }

  let result;
  try {
    result = await publisher.publish(db, ctx.organizationId, detail.googlePost);
  } catch (error) {
    console.error("[showcase] Google post failed", {
      showcase: publicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    result = { ok: false as const, message: "Google did not accept the post." };
  }

  await db
    .update(showcases)
    .set(
      result.ok
        ? { googleStatus: "posted", googlePostName: result.postName, googlePostedAt: now, googleError: null, updatedAt: now }
        : { googleStatus: "failed", googleError: result.message, updatedAt: now },
    )
    .where(where);
}

/**
 * Approve the wording, then send the page to the site and the post to Google.
 *
 * Approval stands even when the site page has to wait: the graphics and the
 * Google post do not depend on it, and the page can be sent again from the
 * showcase once whatever blocked it has cleared.
 */
export async function approveShowcase(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: { title: unknown; writeUp: unknown; caption: unknown },
  options: { publisher?: GooglePostPublisher } = {},
): Promise<ShowcaseMessage> {
  assertMutable(ctx);
  const checked = validateWording(input);
  if (!checked.ok) return checked;

  const now = new Date();
  const approved = await db
    .update(showcases)
    .set({ ...checked.wording, status: "approved", approvedAt: now, approvedBy: ctx.userId, updatedAt: now })
    .where(
      and(
        eq(showcases.publicId, publicId),
        eq(showcases.organizationId, ctx.organizationId),
        eq(showcases.status, "draft"),
      ),
    )
    .returning({ id: showcases.id });
  if (approved.length === 0) {
    if (await existsFor(db, ctx, publicId)) return ALREADY_APPROVED;
    throw new NotFoundError();
  }

  const site = await sendShowcaseToSite(db, ctx, publicId);
  await publishShowcaseToGoogle(db, ctx, publicId, options.publisher);

  return {
    ok: true,
    message: site.ok
      ? "Approved. Your graphics are ready, and we're making the website page."
      : `Approved. Your graphics are ready. The website page is waiting: ${site.message}`,
  };
}

/** The client posted it to Google themselves. */
export async function markPostedToGoogle(db: Database, ctx: TenantContext, publicId: string): Promise<void> {
  assertMutable(ctx);
  const now = new Date();
  const updated = await db
    .update(showcases)
    .set({ googleStatus: "posted", googlePostedAt: now, googleError: null, updatedAt: now })
    .where(
      and(
        eq(showcases.publicId, publicId),
        eq(showcases.organizationId, ctx.organizationId),
        eq(showcases.status, "approved"),
        inArray(showcases.googleStatus, ["manual", "failed"]),
      ),
    )
    .returning({ id: showcases.id });
  if (updated.length === 0 && !(await existsFor(db, ctx, publicId))) throw new NotFoundError();
}

/**
 * Remove a showcase from the list. A change request it already opened is
 * left alone: it is the client's own request now, with its own controls under
 * Requests, and a page that went live stays live.
 */
export async function deleteShowcase(db: Database, ctx: TenantContext, publicId: string): Promise<void> {
  assertMutable(ctx);
  const deleted = await db
    .delete(showcases)
    .where(and(eq(showcases.publicId, publicId), eq(showcases.organizationId, ctx.organizationId)))
    .returning({ id: showcases.id });
  if (deleted.length === 0) throw new NotFoundError();
}

// ---------------------------------------------------------------------------
// Graphics
// ---------------------------------------------------------------------------

/** Largest first: a 1080px graphic needs more than the 1200px preview at most. */
const SOURCE_PREFERENCE = ["web_lg", "web_md", "preview"] as const;

export interface GraphicSources {
  title: string;
  /** The text on the graphic. */
  caption: string;
  /** The suggested post text, for the zip. */
  socialCaption: string;
  businessName: string;
  brand: BrandColours;
  /** Before then after when `pair`, otherwise the cover photo alone. */
  photos: Uint8Array[];
  pair: boolean;
}

async function photoBytes(db: Database, asset: { id: string; storageKey: string | null }): Promise<Uint8Array | null> {
  const derivatives = await db
    .select({ kind: mediaDerivatives.kind, storageKey: mediaDerivatives.storageKey })
    .from(mediaDerivatives)
    .where(and(eq(mediaDerivatives.assetId, asset.id), inArray(mediaDerivatives.kind, [...SOURCE_PREFERENCE])));
  const keys = [
    ...SOURCE_PREFERENCE.map((kind) => derivatives.find((d) => d.kind === kind)?.storageKey),
    asset.storageKey,
  ].filter((key): key is string => Boolean(key));

  for (const key of keys) {
    const object = await mediaDriver().get(key);
    if (object) return object.bytes;
  }
  return null;
}

export async function loadGraphicSources(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<GraphicSources> {
  const [row] = await db
    .select({ id: showcases.id, title: showcases.title, caption: showcases.caption })
    .from(showcases)
    .where(and(eq(showcases.publicId, publicId), eq(showcases.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();

  const photos = await db
    .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, role: showcasePhotos.role })
    .from(showcasePhotos)
    .innerJoin(mediaAssets, eq(mediaAssets.id, showcasePhotos.assetId))
    .where(
      and(
        eq(showcasePhotos.showcaseId, row.id),
        eq(mediaAssets.organizationId, ctx.organizationId),
        eq(mediaAssets.status, "ready"),
        sql`${mediaAssets.deletedAt} IS NULL`,
      ),
    )
    .orderBy(asc(showcasePhotos.position));

  const before = photos.find((p) => p.role === "before");
  const after = photos.find((p) => p.role === "after");
  const chosen = before && after ? [before, after] : [after ?? photos[0]].filter((p) => p !== undefined);

  const bytes: Uint8Array[] = [];
  for (const photo of chosen) {
    const read = await photoBytes(db, photo);
    if (read) bytes.push(read);
  }

  const profile = await profileFor(db, ctx);
  return {
    title: row.title,
    caption: graphicCaption(row.title),
    socialCaption: row.caption,
    businessName: await businessNameFor(db, ctx, profile),
    brand: brandColours(profile),
    photos: bytes,
    pair: bytes.length === 2 && chosen.length === 2,
  };
}
