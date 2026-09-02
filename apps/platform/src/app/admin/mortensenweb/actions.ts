"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getInternalClient } from "@/db/repositories/admin/clients";
import {
  cancelInternalChangeRequest,
  createInternalChangeRequest,
  type NewInternalRequestInput,
} from "@/db/repositories/admin/internal-requests";

const CATEGORIES: readonly NonNullable<NewInternalRequestInput["category"]>[] = [
  "content",
  "design",
  "bug",
  "seo",
  "feature",
  "other",
];

const PRIORITIES: readonly NonNullable<NewInternalRequestInput["priority"]>[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type InternalRequestResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** Submitting a change request for the agency's own site — see internal-requests.ts. */
export async function submitInternalRequestAction(
  _previous: InternalRequestResult | null,
  formData: FormData,
): Promise<InternalRequestResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const internal = await getInternalClient(ctx, db);
  if (!internal) {
    return { ok: false, message: "The agency's site isn't linked yet." };
  }

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "");
  const categoryRaw = String(formData.get("category") ?? "other");
  const priorityRaw = String(formData.get("priority") ?? "normal");

  if (!sitePublicId) return { ok: false, message: "No site to attach this to." };
  if (!title) return { ok: false, message: "Give the change a short title." };

  const category = CATEGORIES.includes(
    categoryRaw as (typeof CATEGORIES)[number],
  )
    ? (categoryRaw as (typeof CATEGORIES)[number])
    : "other";
  const priority = PRIORITIES.includes(
    priorityRaw as (typeof PRIORITIES)[number],
  )
    ? (priorityRaw as (typeof PRIORITIES)[number])
    : "normal";

  const result = await createInternalChangeRequest(ctx, db, {
    organizationId: internal.organizationId,
    sitePublicId,
    title,
    description,
    category,
    priority,
  });

  revalidatePath("/admin/mortensenweb");

  if (!result.ok) return { ok: false, message: result.message };
  return {
    ok: true,
    message:
      "Sent — it moves through the same request pipeline as any client's, including the one-open-request rule.",
  };
}

export async function cancelInternalRequestAction(
  _previous: InternalRequestResult | null,
  formData: FormData,
): Promise<InternalRequestResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const internal = await getInternalClient(ctx, db);
  if (!internal) {
    return { ok: false, message: "The agency's site isn't linked yet." };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  const outcome = await cancelInternalChangeRequest(
    ctx,
    db,
    internal.organizationId,
    requestPublicId,
  );

  revalidatePath("/admin/mortensenweb");

  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, message: "Cancelled." };
}
