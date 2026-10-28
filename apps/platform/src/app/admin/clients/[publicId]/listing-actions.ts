"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getClientDetail } from "@/db/repositories/admin/clients";
import { markListingStepForClient } from "@/db/repositories/admin/listings";
import type { MarkResult } from "@/lib/listings/checklist";
import { listingInputFromForm } from "@/lib/listings/form";

/**
 * The operator ticks a listing step on the client's behalf.
 *
 * Re-derives the admin context from the session — a server action is a
 * public POST endpoint — and resolves the site through the client it is
 * said to belong to, so a site id from another client cannot be retargeted
 * from this page.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export async function markListingStepForClientAction(_previous: MarkResult | null, form: FormData): Promise<MarkResult> {
  const ctx = await requireAdmin();
  const db = await getDb();
  const clientPublicId = String(form.get("clientPublicId") ?? "");
  const sitePublicId = String(form.get("sitePublicId") ?? "");

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That client no longer exists." };
    throw error;
  }

  try {
    const result = await markListingStepForClient(ctx, db, detail.organization.id, sitePublicId, listingInputFromForm(form));
    if (result.ok) revalidatePath(`/admin/clients/${clientPublicId}`);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That site is not on this client." };
    throw error;
  }
}
