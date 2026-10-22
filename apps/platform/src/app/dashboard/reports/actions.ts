"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { setMyReportEmails } from "@/db/repositories/client/reports";

/**
 * The monthly email switch. A server action is a public POST endpoint, so the
 * organization comes from the session, never from the form.
 */

export type ReportEmailsResult = { ok: true; message: string } | { ok: false; message: string };

export async function setReportEmailsAction(
  _previous: ReportEmailsResult | null,
  formData: FormData,
): Promise<ReportEmailsResult> {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return { ok: false, message: "Please sign in again." };

  const on = formData.get("emails") === "on";
  try {
    await setMyReportEmails(await getDb(), tenantContextFrom(user, user.organizationId), on);
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, message: "This view is read-only." };
    console.error("[reports] could not change the email setting", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: "That didn't save. Please try again." };
  }

  revalidatePath("/dashboard/reports");
  return on
    ? { ok: true, message: "We'll email you a summary on the 1st of each month." }
    : { ok: true, message: "No more monthly emails. Your reports still appear here." };
}
