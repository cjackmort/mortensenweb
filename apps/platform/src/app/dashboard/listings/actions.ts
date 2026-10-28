"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { markListingStep } from "@/db/repositories/client/listings";
import type { MarkResult } from "@/lib/listings/checklist";
import { listingInputFromForm } from "@/lib/listings/form";

/**
 * A client ticks a step on their own checklist. Re-derives the tenant from
 * the session — a server action is a public POST endpoint — and goes through
 * the repository, which refuses a site that is not theirs and a session that
 * is only viewing as them.
 */

export async function markListingStepAction(_previous: MarkResult | null, form: FormData): Promise<MarkResult> {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return { ok: false, message: "Please sign in again." };
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  try {
    const result = await markListingStep(db, ctx, String(form.get("sitePublicId") ?? ""), listingInputFromForm(form));
    if (result.ok) {
      revalidatePath("/dashboard/listings");
      revalidatePath("/dashboard");
    }
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That site is not on your account." };
    if (error instanceof AuthorizationError) return { ok: false, message: "You are viewing as this client, so the list is read-only." };
    throw error;
  }
}
