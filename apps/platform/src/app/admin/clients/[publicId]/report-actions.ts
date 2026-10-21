"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  rebuildClientReport,
  resendClientReport,
  setClientReportEmails,
  type ReportActionResult,
} from "@/db/repositories/admin/reports";

/** Monthly report buttons. Re-derives the admin context: a server action is a public POST. */
async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

function refresh(clientPublicId: string, period?: string) {
  revalidatePath(`/admin/clients/${clientPublicId}`);
  if (period) revalidatePath(`/admin/clients/${clientPublicId}/reports/${period}`);
}

export async function reportAction(_p: ReportActionResult | null, form: FormData): Promise<ReportActionResult> {
  const ctx = await requireAdmin();
  const db = await getDb();
  const clientPublicId = String(form.get("clientPublicId") ?? "");
  const period = String(form.get("period") ?? "");
  const intent = form.get("intent");

  try {
    let result: ReportActionResult;
    if (intent === "rebuild") result = await rebuildClientReport(ctx, db, clientPublicId, period);
    else if (intent === "resend") result = await resendClientReport(ctx, db, clientPublicId, period);
    else if (intent === "emails-on" || intent === "emails-off") {
      result = await setClientReportEmails(ctx, db, clientPublicId, intent === "emails-on");
    } else return { ok: false, message: "Unknown action." };

    refresh(clientPublicId, period || undefined);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That client no longer exists." };
    console.error("[reports] admin action failed", {
      intent,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: "That didn't work. The server log has the detail." };
  }
}
