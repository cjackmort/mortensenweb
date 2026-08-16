"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { attachImageToRequest } from "@/db/repositories/client/attachments";
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
  | { ok: true; publicId: string; attached: number; rejected: string[] }
  | { ok: false; message: string };

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

  const created = await createChangeRequest(db, ctx, {
    title,
    description: description || undefined,
    category: category as never,
    priority: priority as never,
    sitePublicId: sitePublicId || undefined,
  });

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

  return { ok: true, publicId: created.publicId, attached, rejected };
}
