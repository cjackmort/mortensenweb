"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
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

  // Gate two: is there allowance left? This *consumes* it — the claim happens
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
  const rejected: string[] = [];
  let attached = 0;

  for (const file of files) {
    const check = await validateImageUpload(file);
    if (!check.ok) {
      rejected.push(`${file.name}: ${REJECTION_MESSAGES[check.reason]}`);
      continue;
    }
    await attachImageToRequest(db, ctx, created.publicId, check.upload);
    attached += 1;
  }

  revalidatePath("/dashboard/requests");

  return {
    ok: true,
    publicId: created.publicId,
    attached,
    rejected,
    remaining: claim.remaining,
  };
}
