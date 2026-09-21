"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { designateInternalClient } from "@/db/repositories/admin/clients";

export type InternalResult = { ok: boolean; message: string };

/** Make this client the agency's own site. See `designateInternalClient`. */
export async function designateInternalAction(
  _previous: InternalResult | null,
  formData: FormData,
): Promise<InternalResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client specified." };

  const outcome = await designateInternalClient(
    adminContextFrom(user),
    await getDb(),
    clientPublicId,
  );

  if (!outcome.ok) {
    return {
      ok: false,
      message:
        outcome.reason === "archived"
          ? "This client is archived, so the tab would show nothing."
          : "No such client.",
    };
  }

  revalidatePath("/admin/clients");
  revalidatePath("/admin/mortensenweb");
  revalidatePath(`/admin/clients/${clientPublicId}`);

  // Straight to the tab, which is what the operator wants to see next.
  redirect("/admin/mortensenweb");
}
