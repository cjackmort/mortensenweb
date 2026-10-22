import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  googleLocations,
  googleProfileChanges,
  googleProfileRequests,
  googleReviews,
  mediaAssets,
} from "@/db/schema";
import { DESCRIPTION_MAX, POST_SUMMARY_MAX, type GoogleBusinessClient } from "@/lib/google-business/client";
import { describeGoogleError } from "@/lib/google-business/errors";
import { describeWeek, describeSpecialDay, formatDay } from "@/lib/google-business/hours";
import { readSnapshot } from "@/lib/google-business/normalize";
import { draftReviewReply, REPLY_MAX } from "@/lib/google-business/reply-draft";
import { CTA_TYPES, type CtaType, type ProfileSnapshot, type SpecialDay, type WeeklyHours } from "@/lib/google-business/types";
import { mediaAssetUrl } from "@/lib/storage/signed-links";
import { NotFoundError, type AdminContext } from "../context";
import { clientForGoogle } from "./google-profile";
import { GoogleUnavailableError, withGoogle } from "./google-connection";
import { businessVoiceFor, syncLocation } from "./google-sync";

/**
 * Everything the operator changes on a client's Google profile.
 *
 * Each edit reads the profile from Google first and writes it after, so the
 * change log records what Google actually held before — not the portal's
 * possibly hours-old copy — and the snapshot afterwards is Google's own. A
 * failed edit is logged too, with Google's reason: "the hours were changed"
 * must never be assumed from the operator having pressed the button.
 *
 * Nothing here runs on its own. A review reply is drafted automatically, but
 * only an operator's press of "Post reply" publishes it.
 */

export type EditResult = { ok: true; message: string } | { ok: false; message: string };

type ChangeKind = "hours" | "special_hours" | "description" | "post" | "photo" | "review_reply";

interface LinkedLocation {
  id: string;
  organizationId: string;
  accountName: string;
  locationName: string;
  metricsSyncedAt: Date | null;
  syncFailures: number;
}

async function linkedLocation(ctx: AdminContext, db: Database, clientPublicId: string): Promise<LinkedLocation> {
  const client = await clientForGoogle(ctx, db, clientPublicId);
  const [location] = await db
    .select({
      id: googleLocations.id,
      organizationId: googleLocations.organizationId,
      accountName: googleLocations.accountName,
      locationName: googleLocations.locationName,
      metricsSyncedAt: googleLocations.metricsSyncedAt,
      syncFailures: googleLocations.syncFailures,
    })
    .from(googleLocations)
    .where(eq(googleLocations.clientId, client.id))
    .limit(1);
  if (!location) throw new NotFoundError("No Google profile is linked for this client.");
  return location;
}

/** The client's open ask this change answers, if the form named one. */
async function requestIdFor(db: Database, organizationId: string, requestPublicId: string | null | undefined) {
  if (!requestPublicId) return null;
  const [row] = await db
    .select({ id: googleProfileRequests.id })
    .from(googleProfileRequests)
    .where(and(eq(googleProfileRequests.publicId, requestPublicId), eq(googleProfileRequests.organizationId, organizationId)))
    .limit(1);
  return row?.id ?? null;
}

async function logChange(
  db: Database,
  ctx: AdminContext,
  location: LinkedLocation,
  entry: {
    kind: ChangeKind;
    summary: string;
    before?: unknown;
    after?: unknown;
    status: "applied" | "failed";
    error?: string | null;
    googleName?: string | null;
    requestId?: string | null;
  },
): Promise<void> {
  await db.insert(googleProfileChanges).values({
    locationId: location.id,
    organizationId: location.organizationId,
    kind: entry.kind,
    summary: entry.summary,
    before: entry.before ?? null,
    after: entry.after ?? null,
    status: entry.status,
    error: entry.error ?? null,
    googleName: entry.googleName ?? null,
    actorUserId: ctx.userId,
    requestId: entry.requestId ?? null,
  });
}

function failureMessage(error: unknown): string {
  if (error instanceof GoogleUnavailableError) return error.message;
  return describeGoogleError(error);
}

async function saveSnapshot(db: Database, location: LinkedLocation, snapshot: ProfileSnapshot): Promise<void> {
  const now = new Date();
  await db
    .update(googleLocations)
    .set({ snapshot, snapshotAt: now, title: snapshot.title, updatedAt: now })
    .where(eq(googleLocations.id, location.id));
}

/**
 * One profile edit: read Google's current value, write the new one, store
 * Google's answer, and log it either way.
 */
async function applyProfileEdit<T>(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  edit: {
    kind: ChangeKind;
    summary: string;
    requestPublicId?: string | null;
    read: (snapshot: ProfileSnapshot) => T;
    write: (google: GoogleBusinessClient, locationName: string) => Promise<ProfileSnapshot>;
    after: T;
  },
): Promise<EditResult> {
  const location = await linkedLocation(ctx, db, clientPublicId);
  const requestId = await requestIdFor(db, location.organizationId, edit.requestPublicId);

  let before: T | null = null;
  try {
    const updated = await withGoogle(db, async (google) => {
      before = edit.read(await google.getLocation(location.locationName));
      return edit.write(google, location.locationName);
    });
    await saveSnapshot(db, location, updated);
    await logChange(db, ctx, location, { kind: edit.kind, summary: edit.summary, before, after: edit.read(updated), status: "applied", requestId });
    const pending = updated.hasPendingEdits ? " Google may review it before it shows." : "";
    return { ok: true, message: `${edit.summary}.${pending}` };
  } catch (error) {
    const message = failureMessage(error);
    await logChange(db, ctx, location, { kind: edit.kind, summary: edit.summary, before, after: edit.after, status: "failed", error: message, requestId });
    return { ok: false, message };
  }
}

// ---------------------------------------------------------------------------
// Linking a client to a location
// ---------------------------------------------------------------------------

const ACCOUNT_NAME = /^accounts\/[\w-]+$/;
const LOCATION_NAME = /^locations\/[\w-]+$/;

export async function linkGoogleLocation(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  { accountName, locationName }: { accountName: string; locationName: string },
): Promise<EditResult> {
  if (!ACCOUNT_NAME.test(accountName) || !LOCATION_NAME.test(locationName)) {
    return { ok: false, message: "Pick a profile from the list." };
  }
  const client = await clientForGoogle(ctx, db, clientPublicId);

  const [taken] = await db
    .select({ clientId: googleLocations.clientId })
    .from(googleLocations)
    .where(eq(googleLocations.locationName, locationName))
    .limit(1);
  if (taken && taken.clientId !== client.id) {
    return { ok: false, message: "That profile is already linked to another client." };
  }

  let snapshot: ProfileSnapshot;
  try {
    // Confirm the agency can actually read it before promising anything.
    snapshot = await withGoogle(db, (google) => google.getLocation(locationName));
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }

  const now = new Date();
  // Moving a client to a different profile starts its copy over: reviews and
  // figures from the wrong profile would be someone else's.
  await db.delete(googleLocations).where(eq(googleLocations.clientId, client.id));
  const [row] = await db
    .insert(googleLocations)
    .values({
      clientId: client.id,
      organizationId: client.organizationId,
      accountName,
      locationName,
      title: snapshot.title,
      snapshot,
      snapshotAt: now,
      linkedBy: ctx.userId,
      linkedAt: now,
      nextSyncAt: now,
    })
    .returning({
      id: googleLocations.id,
      organizationId: googleLocations.organizationId,
      accountName: googleLocations.accountName,
      locationName: googleLocations.locationName,
      metricsSyncedAt: googleLocations.metricsSyncedAt,
      syncFailures: googleLocations.syncFailures,
    });

  await db.insert(auditLog).values({
    action: "google.location_linked",
    entityType: "google_location",
    entityId: row!.id,
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    metadata: { locationName, title: snapshot.title },
  });

  try {
    await syncLocation(db, row!, { now });
    return { ok: true, message: `Linked to ${snapshot.title ?? locationName} and synced.` };
  } catch (error) {
    return { ok: true, message: `Linked to ${snapshot.title ?? locationName}. The first sync did not finish: ${failureMessage(error)}` };
  }
}

export async function unlinkGoogleLocation(ctx: AdminContext, db: Database, clientPublicId: string): Promise<EditResult> {
  const client = await clientForGoogle(ctx, db, clientPublicId);
  const deleted = await db
    .delete(googleLocations)
    .where(eq(googleLocations.clientId, client.id))
    .returning({ locationName: googleLocations.locationName });
  if (deleted.length === 0) return { ok: true, message: "No profile was linked." };
  await db.insert(auditLog).values({
    action: "google.location_unlinked",
    entityType: "google_location",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    metadata: { locationName: deleted[0]!.locationName },
  });
  return { ok: true, message: "Unlinked. The profile itself is unchanged on Google." };
}

export async function acceptGoogleInvitation(ctx: AdminContext, db: Database, invitationName: string): Promise<EditResult> {
  if (!/^accounts\/[\w-]+\/invitations\/[\w-]+$/.test(invitationName)) {
    return { ok: false, message: "That invitation is not one Google listed." };
  }
  try {
    await withGoogle(db, (google) => google.acceptInvitation(invitationName));
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
  await db.insert(auditLog).values({
    action: "google.invitation_accepted",
    entityType: "google_connection",
    entityId: null,
    actorUserId: ctx.userId,
    metadata: { invitation: invitationName },
  });
  return { ok: true, message: "Accepted. The profile now appears in the list to link." };
}

export async function syncGoogleClientNow(ctx: AdminContext, db: Database, clientPublicId: string): Promise<EditResult> {
  const location = await linkedLocation(ctx, db, clientPublicId);
  try {
    await syncLocation(db, location, { includeMetrics: true });
    return { ok: true, message: "Synced from Google." };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Hours, special hours, description
// ---------------------------------------------------------------------------

function weekSummary(week: WeeklyHours): string {
  return describeWeek(week)
    .map((line) => `${line.days} ${line.hours}`)
    .join("; ");
}

export function updateGoogleHours(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  week: WeeklyHours,
  requestPublicId?: string | null,
): Promise<EditResult> {
  return applyProfileEdit(ctx, db, clientPublicId, {
    kind: "hours",
    summary: `Hours set to ${weekSummary(week)}`,
    requestPublicId,
    read: (s) => s.hours,
    write: (google, name) => google.updateHours(name, week),
    after: week,
  });
}

export async function updateGoogleSpecialHours(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  days: SpecialDay[],
  requestPublicId?: string | null,
): Promise<EditResult> {
  const summary =
    days.length === 0
      ? "Special hours cleared"
      : `Special hours: ${days.map((d) => `${formatDay(d.date)} ${describeSpecialDay(d)}`).join("; ")}`;
  return applyProfileEdit(ctx, db, clientPublicId, {
    kind: "special_hours",
    summary: summary.length > 300 ? `${summary.slice(0, 297)}…` : summary,
    requestPublicId,
    read: (s) => s.specialHours,
    write: (google, name) => google.updateSpecialHours(name, days),
    after: days,
  });
}

export function validateDescription(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: false, message: "Write a description." };
  if (value.length > DESCRIPTION_MAX) return { ok: false, message: `Google allows ${DESCRIPTION_MAX} characters; this is ${value.length}.` };
  // Google's guidelines refuse links in the description, and reject the edit.
  if (/https?:\/\/|www\./i.test(value)) return { ok: false, message: "Google does not allow links in the description." };
  return { ok: true, value };
}

export async function updateGoogleDescription(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  raw: string,
  requestPublicId?: string | null,
): Promise<EditResult> {
  const checked = validateDescription(raw);
  if (!checked.ok) return checked;
  return applyProfileEdit(ctx, db, clientPublicId, {
    kind: "description",
    summary: "Description updated",
    requestPublicId,
    read: (s) => s.description,
    write: (google, name) => google.updateDescription(name, checked.value),
    after: checked.value,
  });
}

// ---------------------------------------------------------------------------
// Posts and photos
// ---------------------------------------------------------------------------

export interface PostRequest {
  summary: string;
  /** A media-library asset of this client's. */
  mediaAssetPublicId?: string | null;
  cta?: { type: string; url?: string | null } | null;
  requestPublicId?: string | null;
}

function validCta(cta: PostRequest["cta"]): { ok: true; value: { type: CtaType; url: string | null } | null } | { ok: false; message: string } {
  if (!cta || !cta.type) return { ok: true, value: null };
  if (!(CTA_TYPES as readonly string[]).includes(cta.type)) return { ok: false, message: "Pick a button type." };
  const type = cta.type as CtaType;
  if (type === "CALL") return { ok: true, value: { type, url: null } };
  try {
    const url = new URL(cta.url ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    return { ok: true, value: { type, url: url.toString() } };
  } catch {
    return { ok: false, message: "The button needs a full web address, starting with https://." };
  }
}

/** A ready photo in the client's own library — never another client's. */
async function libraryPhoto(db: Database, organizationId: string, assetPublicId: string) {
  const [asset] = await db
    .select({ publicId: mediaAssets.publicId, filename: mediaAssets.originalFilename, contentType: mediaAssets.contentType })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.publicId, assetPublicId),
        eq(mediaAssets.organizationId, organizationId),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .limit(1);
  if (!asset || !["image/jpeg", "image/png", "image/webp"].includes(asset.contentType ?? "")) return null;
  return asset;
}

/**
 * Publish a post on the client's profile. The integration point for Job
 * showcase: pass a media-library asset and it goes to Google as a 30-minute
 * signed link, which Google fetches once when the post is created.
 */
export async function publishGooglePost(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  input: PostRequest,
): Promise<EditResult> {
  const summary = input.summary.replace(/\r\n?/g, "\n").trim();
  if (!summary) return { ok: false, message: "Write the post." };
  if (summary.length > POST_SUMMARY_MAX) return { ok: false, message: `Google allows ${POST_SUMMARY_MAX} characters; this is ${summary.length}.` };
  const cta = validCta(input.cta);
  if (!cta.ok) return cta;

  let location: LinkedLocation;
  try {
    location = await linkedLocation(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "No Google profile is linked for this client yet." };
    throw error;
  }
  const requestId = await requestIdFor(db, location.organizationId, input.requestPublicId);

  let photoUrl: string | null = null;
  let photoName: string | null = null;
  if (input.mediaAssetPublicId) {
    const asset = await libraryPhoto(db, location.organizationId, input.mediaAssetPublicId);
    if (!asset) return { ok: false, message: "That photo is not in this client's library, or is not a JPEG, PNG or WebP." };
    photoUrl = await mediaAssetUrl(asset.publicId);
    if (!photoUrl) return { ok: false, message: "Photo links cannot be signed on this server (AUTH_URL or AUTH_SECRET is missing)." };
    photoName = asset.filename;
  }

  const after = { summary, photo: photoName, cta: cta.value };
  const short = summary.length > 80 ? `${summary.slice(0, 79)}…` : summary;
  try {
    const post = await withGoogle(db, (google) =>
      google.createPost(location.accountName, location.locationName, { summary, photoUrl, cta: cta.value }),
    );
    const now = new Date();
    await db.update(googleLocations).set({ lastPostAt: post.createdAt ?? now, updatedAt: now }).where(eq(googleLocations.id, location.id));
    await logChange(db, ctx, location, {
      kind: "post",
      summary: `Posted: "${short}"`,
      after: { ...after, searchUrl: post.searchUrl, state: post.state },
      status: "applied",
      googleName: post.name,
      requestId,
    });
    return {
      ok: true,
      message: post.state === "REJECTED" ? "Google received the post but rejected it. Check it on the profile." : "Posted to Google.",
    };
  } catch (error) {
    const message = failureMessage(error);
    await logChange(db, ctx, location, { kind: "post", summary: `Post: "${short}"`, after, status: "failed", error: message, requestId });
    return { ok: false, message };
  }
}

export async function addGooglePhoto(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  assetPublicId: string,
): Promise<EditResult> {
  const location = await linkedLocation(ctx, db, clientPublicId);
  const asset = await libraryPhoto(db, location.organizationId, assetPublicId);
  if (!asset) return { ok: false, message: "That photo is not in this client's library, or is not a JPEG, PNG or WebP." };
  const url = await mediaAssetUrl(asset.publicId);
  if (!url) return { ok: false, message: "Photo links cannot be signed on this server (AUTH_URL or AUTH_SECRET is missing)." };

  try {
    const created = await withGoogle(db, (google) => google.addPhoto(location.accountName, location.locationName, url));
    await db
      .update(googleLocations)
      .set({ photoCount: null, nextSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(googleLocations.id, location.id));
    await logChange(db, ctx, location, { kind: "photo", summary: `Photo added: ${asset.filename}`, after: { photo: asset.filename }, status: "applied", googleName: created.name });
    return { ok: true, message: "Photo sent to Google. It can take a few minutes to appear." };
  } catch (error) {
    const message = failureMessage(error);
    await logChange(db, ctx, location, { kind: "photo", summary: `Photo: ${asset.filename}`, after: { photo: asset.filename }, status: "failed", error: message });
    return { ok: false, message };
  }
}

// ---------------------------------------------------------------------------
// Review replies
// ---------------------------------------------------------------------------

async function reviewFor(ctx: AdminContext, db: Database, clientPublicId: string, reviewId: string) {
  const location = await linkedLocation(ctx, db, clientPublicId);
  const [review] = await db
    .select()
    .from(googleReviews)
    .where(and(eq(googleReviews.id, reviewId), eq(googleReviews.locationId, location.id)))
    .limit(1);
  if (!review) throw new NotFoundError();
  return { location, review };
}

function validReply(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (!value) return { ok: false, message: "Write the reply." };
  if (value.length > REPLY_MAX) return { ok: false, message: `Google allows ${REPLY_MAX} characters.` };
  return { ok: true, value };
}

export async function saveReplyDraft(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  reviewId: string,
  raw: string,
): Promise<EditResult> {
  const checked = validReply(raw);
  if (!checked.ok) return checked;
  const { review } = await reviewFor(ctx, db, clientPublicId, reviewId);
  await db
    .update(googleReviews)
    .set({ draftReply: checked.value, draftSource: "operator", draftUpdatedAt: new Date(), updatedAt: new Date() })
    .where(eq(googleReviews.id, review.id));
  return { ok: true, message: "Draft saved. Nothing is posted until you press Post reply." };
}

/** Throw away the draft and write a fresh one from the review and the business details. */
export async function redraftReply(ctx: AdminContext, db: Database, clientPublicId: string, reviewId: string): Promise<EditResult> {
  const { location, review } = await reviewFor(ctx, db, clientPublicId, reviewId);
  const [row] = await db.select({ snapshot: googleLocations.snapshot }).from(googleLocations).where(eq(googleLocations.id, location.id));
  const voice = await businessVoiceFor(db, location.organizationId, readSnapshot(row?.snapshot));
  const draft = draftReviewReply(
    { reviewId: review.googleReviewId, reviewerName: review.reviewerName, starRating: review.starRating, comment: review.comment },
    voice,
  );
  await db
    .update(googleReviews)
    .set({ draftReply: draft, draftSource: "portal", draftUpdatedAt: new Date(), updatedAt: new Date() })
    .where(eq(googleReviews.id, review.id));
  return { ok: true, message: "Drafted again from the review and the business details." };
}

/** Publish a reply. The operator's text, exactly; this is the only path that posts one. */
export async function postReviewReply(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  reviewId: string,
  raw: string,
): Promise<EditResult> {
  const checked = validReply(raw);
  if (!checked.ok) return checked;
  const { location, review } = await reviewFor(ctx, db, clientPublicId, reviewId);
  if (review.removedAt) return { ok: false, message: "That review is no longer on Google." };

  const who = review.reviewerName ?? "an anonymous reviewer";
  try {
    const reply = await withGoogle(db, (google) =>
      google.replyToReview(location.accountName, location.locationName, review.googleReviewId, checked.value),
    );
    const now = new Date();
    await db
      .update(googleReviews)
      .set({
        replyComment: reply.comment,
        repliedAt: reply.updatedAt ?? now,
        draftReply: null,
        draftSource: null,
        draftUpdatedAt: null,
        replyError: null,
        updatedAt: now,
      })
      .where(eq(googleReviews.id, review.id));
    await logChange(db, ctx, location, {
      kind: "review_reply",
      summary: `Replied to ${who}`,
      before: review.replyComment,
      after: reply.comment,
      status: "applied",
    });
    return { ok: true, message: "Reply posted on Google." };
  } catch (error) {
    const message = failureMessage(error);
    await db
      .update(googleReviews)
      .set({ draftReply: checked.value, draftSource: "operator", replyError: message, updatedAt: new Date() })
      .where(eq(googleReviews.id, review.id));
    await logChange(db, ctx, location, {
      kind: "review_reply",
      summary: `Reply to ${who}`,
      after: checked.value,
      status: "failed",
      error: message,
    });
    return { ok: false, message };
  }
}

// ---------------------------------------------------------------------------
// The client's asks
// ---------------------------------------------------------------------------

export async function resolveGoogleRequest(
  ctx: AdminContext,
  db: Database,
  requestPublicId: string,
  { status, note }: { status: "done" | "declined" | "open"; note?: string | null },
): Promise<EditResult> {
  const trimmed = note?.trim().slice(0, 1000) || null;
  if (status === "declined" && !trimmed) {
    return { ok: false, message: "Say why, so the client knows what happens instead." };
  }
  const now = new Date();
  const updated = await db
    .update(googleProfileRequests)
    .set({
      status,
      operatorNote: trimmed,
      resolvedBy: status === "open" ? null : ctx.userId,
      resolvedAt: status === "open" ? null : now,
      updatedAt: now,
    })
    .where(eq(googleProfileRequests.publicId, requestPublicId))
    .returning({ id: googleProfileRequests.id });
  if (updated.length === 0) return { ok: false, message: "That request no longer exists." };
  return {
    ok: true,
    message: status === "done" ? "Marked done. The client sees it as done." : status === "declined" ? "Closed with your note." : "Reopened.",
  };
}

