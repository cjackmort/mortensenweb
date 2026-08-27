"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  createChangeRequest,
  findOpenRequestForSite,
  getChangeRequestOrThrow,
} from "@/db/repositories/client/change-requests";
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
 * Submitting a change request, with photos.
 *
 * The important behaviour here is what happens when one photo is rejected: the
 * request is still created, and the rejection is reported per-file. A client who
 * has typed three paragraphs on a phone and attached four photos, one of which
 * is a PDF, must not lose the other five minutes of work. Losing typed input to
 * a validation error is the fastest way to make someone stop using the portal.
 *
 * Every file is validated by inspecting its bytes — see `lib/storage`. Nothing
 * here trusts the browser's declared content type or the submitted filename.
 */

export type RequestSubmission =
  | {
      ok: true;
      publicId: string;
      attached: number;
      rejected: string[];
      /** Null when the plan is unlimited. Drives the "2 left this month" line. */
      remaining: number | null;
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
    });
  } catch (error) {
    // The allowance was claimed and the request was not created. Give it back —
    // charging someone for a change that does not exist is a billing error they
    // will notice and we would not.
    await refundChange(db, claim.allowanceId);
    throw error;
  }

  // Photos are attached after the request exists, and a failure on one is
  // reported rather than thrown — the request itself is already saved.
  //
  // Uploaded in parallel rather than one after another. Each attachment is a
  // round trip to blob storage, and six of them in series against a ten-second
  // function budget is most of the budget spent waiting. Sequentially this was
  // timing out and the client saw a connection error having lost everything
  // they typed.
  const results = await Promise.all(
    files.map(async (file, position) => {
      const check = await validateImageUpload(file);
      if (!check.ok) {
        return { ok: false as const, note: `${file.name}: ${REJECTION_MESSAGES[check.reason]}` };
      }
      await attachImageToRequest(db, ctx, created.publicId, check.upload, {
        // The name and description typed beside this thumbnail. Indexed by
        // position, which matches because the form renders one pair of fields
        // per picked file and the input's `files` list is what was submitted.
        title: String(formData.get(`photoTitle${position}`) ?? ""),
        caption: String(formData.get(`photoCaption${position}`) ?? ""),
      });
      return { ok: true as const };
    }),
  );

  const rejected = results.filter((r) => !r.ok).map((r) => r.note!);
  const attached = results.filter((r) => r.ok).length;

  // Automatic dispatch is deliberately NOT done here any more.
  //
  // Opening a GitHub issue is a network round trip, and doing it inside the
  // submit action put it in the same ten-second budget as the blob uploads.
  // Together they were enough to time the function out, and a client whose
  // request "failed" had in fact had it saved — they just could not tell, so
  // they typed it again.
  //
  // The scheduled job picks up `submitted` requests instead, within five
  // minutes. Nothing downstream cares about the delay: a preview has to be
  // built and then reviewed before the client sees it either way.

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
