"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { createCampaign, setCampaignPaused, updateCampaign } from "@/db/repositories/client/campaigns";

/**
 * Campaign mutations. Each re-derives the tenant from the session: a server
 * action is a public POST endpoint, and the public id in the form is only
 * ever looked up inside the caller's own organization.
 */

export type CampaignActionResult = { ok: true; message: string } | { ok: false; message: string };

const SIGN_IN: CampaignActionResult = { ok: false, message: "Please sign in again." };
const LOCKED: CampaignActionResult = {
  ok: false,
  message: "Your plan does not include QR & campaign tracking. See Growth to add it.",
};

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  return { ctx, db, allowed: await requireGrowthFeature(db, ctx, "campaigns") };
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

export async function createCampaignAction(
  _previous: CampaignActionResult | null,
  form: FormData,
): Promise<CampaignActionResult> {
  const session = await context();
  if (!session) return SIGN_IN;
  if (!session.allowed) return LOCKED;

  const result = await createCampaign(session.db, session.ctx, {
    name: field(form, "name"),
    placement: field(form, "placement"),
    sitePublicId: field(form, "site"),
    destination: field(form, "destination"),
  });
  if (!result.ok) return result;

  revalidatePath("/dashboard/growth/campaigns");
  redirect(`/dashboard/growth/campaigns/${result.publicId}?created=1`);
}

export async function updateCampaignAction(
  _previous: CampaignActionResult | null,
  form: FormData,
): Promise<CampaignActionResult> {
  const session = await context();
  if (!session) return SIGN_IN;
  if (!session.allowed) return LOCKED;

  const publicId = field(form, "campaign");
  const result = await updateCampaign(session.db, session.ctx, publicId, {
    name: field(form, "name"),
    destination: field(form, "destination"),
  });
  if (!result.ok) return result;

  revalidatePath(`/dashboard/growth/campaigns/${publicId}`);
  revalidatePath("/dashboard/growth/campaigns");
  return { ok: true, message: "Saved. The code opens the new page from the next scan." };
}

export async function setCampaignPausedAction(
  _previous: CampaignActionResult | null,
  form: FormData,
): Promise<CampaignActionResult> {
  const session = await context();
  if (!session) return SIGN_IN;
  if (!session.allowed) return LOCKED;

  const publicId = field(form, "campaign");
  const paused = field(form, "paused") === "1";
  try {
    await setCampaignPaused(session.db, session.ctx, publicId, paused);
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, message: "That campaign no longer exists." };
    throw error;
  }

  revalidatePath(`/dashboard/growth/campaigns/${publicId}`);
  revalidatePath("/dashboard/growth/campaigns");
  return paused
    ? { ok: true, message: "Paused. The code still opens your page; scans are no longer counted." }
    : { ok: true, message: "Counting again from the next scan." };
}
