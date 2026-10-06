"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { deleteLead, isLeadStatus, setLeadStatus } from "@/db/repositories/client/leads";

/**
 * Lead mutations. Both re-derive the tenant from the session: a server action
 * is a public POST endpoint, and the public id in the form is only ever looked
 * up inside the caller's own organization.
 */

export type LeadActionResult = { ok: true; message: string } | { ok: false; message: string };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  return { ctx: tenantContextFrom(user, user.organizationId), db: await getDb() };
}

function refresh(publicId: string) {
  // "layout" so the unread count on the Growth tab is recomputed too.
  revalidatePath("/dashboard", "layout");
  revalidatePath(`/dashboard/growth/leads/${publicId}`);
}

const STATUS_SAVED: Record<string, string> = {
  new: "Marked as new.",
  contacted: "Marked as contacted.",
  won: "Marked as won — nice.",
  lost: "Marked as lost.",
  archived: "Archived. It stays under Archived if you need it.",
};

export async function setLeadStatusAction(
  _previous: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const publicId = String(formData.get("lead") ?? "");
  const status = formData.get("status");
  if (!isLeadStatus(status)) return { ok: false, message: "Pick a status." };

  try {
    await setLeadStatus(session.db, session.ctx, publicId, status);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That enquiry no longer exists." };
    }
    throw error;
  }

  refresh(publicId);
  return { ok: true, message: STATUS_SAVED[status] ?? "Saved." };
}

export async function deleteLeadAction(formData: FormData): Promise<void> {
  const session = await context();
  if (!session) redirect("/login");

  const publicId = String(formData.get("lead") ?? "");
  try {
    await deleteLead(session.db, session.ctx, publicId);
  } catch (error) {
    // Already gone is the outcome they asked for.
    if (!(error instanceof NotFoundError)) throw error;
  }

  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/growth/leads?deleted=1");
}
