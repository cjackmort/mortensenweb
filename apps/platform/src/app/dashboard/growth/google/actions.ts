"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { askForGoogleChange, type AskResult } from "@/db/repositories/client/google-profile";

/**
 * The client's one write on this page: asking for a change to their Google
 * profile. The tenant comes from the session, never the form, and the
 * repository re-checks the plan, so a POST from a client without the feature
 * is refused even though the page would not have shown them the form.
 */

export async function askForGoogleChangeAction(_previous: AskResult | null, formData: FormData): Promise<AskResult> {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return { ok: false, message: "Please sign in again." };

  const ctx = tenantContextFrom(user, user.organizationId);
  const result = await askForGoogleChange(await getDb(), ctx, String(formData.get("body") ?? ""));
  if (result.ok) revalidatePath("/dashboard/growth/google");
  return result;
}
