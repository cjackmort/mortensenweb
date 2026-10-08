"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { grantAddOn, revokeAddOn, type GrantResult } from "@/db/repositories/admin/growth";

/** Hand-granted Growth add-ons. Re-derives the admin context: a server action is a public POST. */
async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export async function growthAddOnAction(_p: GrantResult | null, form: FormData): Promise<GrantResult> {
  const ctx = await requireAdmin();
  const db = await getDb();
  const clientPublicId = String(form.get("clientPublicId") ?? "");
  const feature = String(form.get("feature") ?? "");
  const grant = form.get("grant") === "1";
  try {
    const result = grant
      ? await grantAddOn(ctx, db, clientPublicId, feature)
      : await revokeAddOn(ctx, db, clientPublicId, feature);
    if (result.ok) revalidatePath(`/admin/clients/${clientPublicId}`);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That client no longer exists." };
    throw error;
  }
}
