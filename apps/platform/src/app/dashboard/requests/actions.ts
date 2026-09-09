"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { nudgeScheduler } from "@/lib/scheduler/nudge";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  addRequestNote,
  createChangeRequest,
  findOpenRequestForSite,
  findRequestByIdempotencyKey,
  getChangeRequestOrThrow,
} from "@/db/repositories/client/change-requests";
import {
  attachAssetsToRequest,
  validateAssetSelection,
} from "@/db/repositories/client/request-assets";
import { cancelChangeRequest } from "@/db/repositories/admin/cancel";
import { NotFoundError } from "@/db/repositories/context";
import { attachImageToRequest } from "@/db/repositories/client/attachments";
import {
  consumeChange,
  getEntitlements,
  refundChange,
} from "@/db/repositories/client/entitlements";
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  REJECTION_MESSAGES,
  validateImageUpload,
} from "@/lib/storage";

/**
 * Submitting a change request.
 *
 * ## Photos do not travel through here any more
 *
 * They used to, and that was the bug. Netlify caps a function request body at
 * about 4.5 MB once binary content is base64-encoded, so a client attaching
 * photos could push the submission past a limit enforced at the platform edge —
 * before any of this code ran. Nothing logged it, no validation message fired,
 * and everything they had typed went with it.
 *
 * Images are now uploaded separately to the media library, in parts, and a
 * submission carries their identifiers. Whatever the client attached, this
 * request body is a few hundred bytes of text.
 *
 * The legacy `photos` field is still read, so a client on a cached page from
 * before this deploy still gets their request saved rather than an error.
 *
 * ## Submitting is idempotent
 *
 * `idempotencyKey` is minted by the browser when the form is first rendered and
 * resent with every retry. A double-tap, a browser retrying a request it was
 * unsure about, or a client pressing Send again after a slow response all carry
 * the same key — and find the request that already exists rather than creating
 * a second one and spending a second change from the allowance.
 */

export type RequestSubmission =
  | {
      ok: true;
      publicId: string;
      attached: number;
      rejected: string[];
      /** Null when the plan is unlimited. Drives the "2 left this month" line. */
      remaining: number | null;
      /**
       * True when this call found a request an earlier attempt had already
       * created. The UI treats it as success — because it is — and says
       * "already sent" rather than pretending to have sent a second one.
       */
      duplicate?: boolean;
    }
  /**
   * The allowance is spent. Distinguished from a plain failure because the UI
   * response is completely different: this is an offer (upgrade, or pay for
   * this one), not an error, and the client has done nothing wrong.
   */
  | {
      ok: false;
      reason: "allowance_exhausted";
      message: string;
      included: number;
      overagePerChangeCents: number | null;
    }
  /**
   * One change is already open on this site. Carries the offender so the form
   * can link to it — "you already have one" without saying which one leaves the
   * client hunting through their history for it.
   */
  | {
      ok: false;
      reason: "one_at_a_time";
      message: string;
      openRequest: { publicId: string; title: string; status: string };
    }
  | { ok: false; reason?: "locked" | "invalid"; message: string };

export async function submitChangeRequest(
  _previous: RequestSubmission | null,
  formData: FormData,
): Promise<RequestSubmission> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      message:
        "Your account is not linked to an organization yet. Please contact us.",
    };
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "other");
  const priority = String(formData.get("priority") ?? "normal");
  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();

  if (title.length < 3) {
    return {
      ok: false,
      message: "Please give the request a short title so we know what it is.",
    };
  }

  const files = formData
    .getAll("photos")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length > MAX_ATTACHMENTS_PER_REQUEST) {
    return { ok: false, message: REJECTION_MESSAGES.too_many };
  }

  // Images chosen from the media library. Identifiers only — the bytes are
  // already in storage.
  const assetPublicIds = formData
    .getAll("assetPublicIds")
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();

  // The cheap path: this exact submission already succeeded, and what arrived
  // is a retry. Answered before the allowance is touched, so a retry is free.
  if (idempotencyKey) {
    const existing = await findRequestByIdempotencyKey(db, ctx, idempotencyKey);
    if (existing) {
      return {
        ok: true,
        publicId: existing.publicId,
        attached: assetPublicIds.length,
        rejected: [],
        remaining: null,
        duplicate: true,
      };
    }
  }

  // Validated before the allowance is claimed and before the request row
  // exists. An image still processing is a reason to ask the client to wait a
  // moment — not a reason to have already charged them for a change and then
  // have to hand it back.
  const selection = await validateAssetSelection(db, ctx, assetPublicIds);
  if (!selection.ok) {
    return { ok: false, reason: "invalid", message: selection.message };
  }

  // Gate one: has the commercial relationship started at all? Checked before
  // the allowance because "you haven't paid yet" and "you're out of changes"
  // are different conversations, and answering the second to someone who has
  // not paid would be nonsense.
  const entitlements = await getEntitlements(db, ctx);
  if (entitlements && !entitlements.changeRequestsUnlocked) {
    return {
      ok: false,
      reason: "locked",
      message:
        "Change requests unlock once your first payment goes through. Head to Billing to get set up.",
    };
  }

  // Gate two: is something already in flight for this site? Before the
  // allowance for the same reason gate one is: "you already have one running"
  // and "you're out of changes" are different conversations, and consuming a
  // change to then refuse the request would spend it on nothing.
  //
  // This is a sequencing rule, not a quota. See `findOpenRequestForSite`.
  let openForSite;
  try {
    openForSite = await findOpenRequestForSite(db, ctx, sitePublicId || undefined);
  } catch {
    // resolveSiteId throws for a site that is not this tenant's.
    return { ok: false, reason: "invalid", message: "We couldn't find that site." };
  }

  if (openForSite) {
    return {
      ok: false,
      reason: "one_at_a_time",
      message:
        "You've already got a change in progress. We do one at a time so a new change is always built on top of the last one — otherwise the second can quietly undo the first.",
      openRequest: {
        publicId: openForSite.publicId,
        title: openForSite.title,
        status: openForSite.status,
      },
    };
  }

  // Gate three: is there allowance left? This *consumes* it — the claim happens
  // before the request is created, so two submissions racing for the last
  // change cannot both win. If anything below fails, it is handed back.
  const claim = await consumeChange(db, ctx);
  if (!claim.ok) {
    if (claim.reason === "no_client") {
      return {
        ok: false,
        reason: "invalid",
        message: "Your account is not linked to a client record yet. Please contact us.",
      };
    }
    return {
      ok: false,
      reason: "allowance_exhausted",
      message:
        claim.included === 1
          ? "You've used your change for this month."
          : `You've used all ${claim.included} of your changes this month.`,
      included: claim.included,
      overagePerChangeCents: claim.overagePerChangeCents,
    };
  }

  let created;
  try {
    created = await createChangeRequest(db, ctx, {
      title,
      description: description || undefined,
      category: category as never,
      priority: priority as never,
      sitePublicId: sitePublicId || undefined,
      allowanceId: claim.allowanceId,
      idempotencyKey: idempotencyKey || undefined,
    });
  } catch (error) {
    // The allowance was claimed and the request was not created. Give it back —
    // charging someone for a change that does not exist is a billing error they
    // will notice and we would not.
    await refundChange(db, claim.allowanceId);
    throw error;
  }

  // Another submission carrying the same key won the race between our lookup
  // above and the insert. It created the request; this one must not be charged
  // for it, so the change claimed a moment ago goes straight back.
  if (created.duplicate) {
    await refundChange(db, claim.allowanceId);
    return {
      ok: true,
      publicId: created.publicId,
      attached: selection.assets.length,
      rejected: [],
      remaining: claim.remaining,
      duplicate: true,
    };
  }

  const rejected: string[] = [];
  let attached = 0;

  // Library images: identifiers into rows that already exist, so this is one
  // insert and cannot fail on the network or on storage.
  if (selection.assets.length > 0) {
    const linked = await attachAssetsToRequest(
      db,
      ctx,
      created.id,
      selection.assets.map((a) => a.publicId),
    );
    if (linked.ok) {
      attached += linked.attached;
    } else {
      // The request is saved and the client is told plainly. They can add the
      // images by replying to it rather than starting over.
      rejected.push(linked.message);
    }
  }

  // The legacy inline path, kept working for a client on a page cached from
  // before this deploy. New submissions send no files at all.
  //
  // Each attachment is wrapped individually. Previously these ran inside a
  // bare `Promise.all`, so a storage failure on any one of them rejected the
  // whole action *after* the request had been created and the allowance spent —
  // the client saw a generic error page, and their change had in fact been
  // charged for and saved. A per-file catch is what makes that impossible.
  for (const [position, file] of files.entries()) {
    try {
      const check = await validateImageUpload(file);
      if (!check.ok) {
        rejected.push(`${file.name}: ${REJECTION_MESSAGES[check.reason]}`);
        continue;
      }
      await attachImageToRequest(db, ctx, created.publicId, check.upload, {
        title: String(formData.get(`photoTitle${position}`) ?? ""),
        caption: String(formData.get(`photoCaption${position}`) ?? ""),
      });
      attached += 1;
    } catch (error) {
      console.warn("[request] attachment failed", {
        request: created.publicId,
        message: error instanceof Error ? error.message : "unknown",
      });
      rejected.push(
        `${file.name}: we could not save this photo. Your request was saved — reply to it to add the photo again.`,
      );
    }
  }

  // Automatic dispatch is deliberately NOT done here any more.
  //
  // Opening a GitHub issue is a network round trip, and doing it inside the
  // submit action put it in the same ten-second budget as the blob uploads.
  // Together they were enough to time the function out, and a client whose
  // request "failed" had in fact had it saved — they just could not tell, so
  // they typed it again.
  //
  // The scheduled job picks up `submitted` requests instead — and is nudged
  // to run right now, after this response has gone back, so the usual wait
  // is seconds rather than the tick. See `lib/scheduler/nudge.ts`.
  nudgeScheduler("request submitted");

  revalidatePath("/dashboard/requests");

  return {
    ok: true,
    publicId: created.publicId,
    attached,
    rejected,
    remaining: claim.remaining,
  };
}

export type CancelRequestResult = { ok: boolean; message: string };

/**
 * "Actually, forget this one."
 *
 * The tenant is resolved from the session and the request is looked up through
 * the tenant-scoped repository *before* anything else happens, so the only
 * thing the form controls is which of their own requests they are cancelling.
 * `getChangeRequestOrThrow` raises `NotFoundError` for another tenant's
 * request, which is reported as not-found rather than forbidden — a 403 would
 * confirm the request exists.
 *
 * Cancelling is what makes the one-at-a-time rule survivable. Without it, a
 * client who dislikes a preview and does not want it rebuilt has no way out of
 * their own open request, and cannot raise anything else until an operator
 * intervenes.
 */
export async function cancelRequest(
  _previous: CancelRequestResult | null,
  formData: FormData,
): Promise<CancelRequestResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return { ok: false, message: "Your account is not linked to an organization yet." };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  if (!requestPublicId) return { ok: false, message: "No request was specified." };

  const reason = String(formData.get("reason") ?? "").trim();

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  let request;
  try {
    request = await getChangeRequestOrThrow(db, ctx, requestPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "We couldn't find that request." };
    }
    throw error;
  }

  const outcome = await cancelChangeRequest(db, {
    requestId: request.id,
    actorUserId: ctx.userId,
    actorType: "client",
    reason,
  });

  revalidatePath("/dashboard/requests");
  revalidatePath("/dashboard");

  return { ok: outcome.ok, message: outcome.message };
}

export type NoteResult = { ok: boolean; message: string };

/**
 * Add a note to a request that is already in progress.
 *
 * Recorded on the request's timeline where the client can see it, and read
 * by whoever handles the next pass on the change. Never a new request, never
 * a charge.
 */
export async function addNote(
  _previous: NoteResult | null,
  formData: FormData,
): Promise<NoteResult> {
  const user = await currentUser();
  if (!user || !user.organizationId) {
    return { ok: false, message: "Please sign in again." };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  const note = String(formData.get("note") ?? "");
  if (!requestPublicId) return { ok: false, message: "No request was specified." };

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    const outcome = await addRequestNote(db, ctx, requestPublicId, note);
    if (!outcome.ok) return { ok: false, message: outcome.message };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "We couldn't find that request." };
    }
    throw error;
  }

  revalidatePath("/dashboard/requests");
  return {
    ok: true,
    message: "Added. We'll see this alongside your request.",
  };
}
