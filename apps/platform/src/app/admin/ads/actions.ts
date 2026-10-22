"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { reviewCampaign } from "@/db/repositories/admin/ads";
import { changeCampaignState, markCampaignLive, recordChannelLaunch } from "@/db/repositories/admin/ad-launch";
import { settleAndRefund } from "@/db/repositories/admin/ad-refund";
import { syncCampaignNow } from "@/db/repositories/admin/ad-sync";

/**
 * The operator's buttons on a campaign. Each checks the session and the role
 * itself: the admin layout redirects, but an action is reachable by POST
 * whatever the layout did.
 */

export type AdminAdResult = { ok: boolean; message: string } | null;

async function operator() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  return { ctx: adminContextFrom(user), db: await getDb() };
}

function campaignOf(formData: FormData): string {
  const value = String(formData.get("campaign") ?? "");
  if (!/^[0-9A-Z]{26}$/.test(value)) throw new Error("Bad campaign id.");
  return value;
}

function refresh(publicId: string) {
  revalidatePath("/admin/ads");
  revalidatePath(`/admin/ads/${publicId}`);
}

export async function reviewAdAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { ctx, db } = await operator();
  const publicId = campaignOf(formData);
  const approve = formData.get("decision") === "approve";
  const outcome = await reviewCampaign(ctx, db, publicId, { approve, note: String(formData.get("note") ?? "") });
  refresh(publicId);
  return outcome.ok
    ? { ok: true, message: approve ? "Approved. Set it up on each platform below." : "Sent back to the client with your note." }
    : { ok: false, message: outcome.message };
}

export async function linkChannelAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { ctx, db } = await operator();
  const publicId = campaignOf(formData);
  const outcome = await recordChannelLaunch(ctx, db, publicId, {
    channel: String(formData.get("channel") ?? ""),
    accountId: String(formData.get("accountId") ?? ""),
    campaignId: String(formData.get("campaignId") ?? ""),
  });
  refresh(publicId);
  return outcome.ok ? { ok: true, message: "Saved." } : { ok: false, message: outcome.message };
}

export async function goLiveAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { ctx, db } = await operator();
  const publicId = campaignOf(formData);
  const outcome = await markCampaignLive(ctx, db, publicId);
  refresh(publicId);
  return outcome.ok ? { ok: true, message: "Live. The client has been told." } : { ok: false, message: outcome.message };
}

export async function changeAdStateAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { ctx, db } = await operator();
  const publicId = campaignOf(formData);
  const change = String(formData.get("change") ?? "");
  if (change !== "pause" && change !== "resume" && change !== "end" && change !== "cancel") {
    return { ok: false, message: "Unknown change." };
  }
  const outcome = await changeCampaignState(ctx, db, publicId, change, {
    note: String(formData.get("note") ?? "").trim() || undefined,
  });
  refresh(publicId);
  return outcome.ok ? { ok: true, message: "Done." } : { ok: false, message: outcome.message };
}

export async function syncAdAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { db } = await operator();
  const publicId = campaignOf(formData);
  const results = await syncCampaignNow(db, publicId);
  refresh(publicId);
  if (results.length === 0) return { ok: false, message: "No channel has platform ids yet." };
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { ok: true, message: "Synced." };
  return { ok: false, message: failed.map((f) => (f.ok ? "" : f.message)).join(" ") };
}

export async function settleAdAction(_previous: AdminAdResult, formData: FormData): Promise<AdminAdResult> {
  const { ctx, db } = await operator();
  const publicId = campaignOf(formData);
  const typed = String(formData.get("finalSpend") ?? "").replace(/[$,\s]/g, "");
  const finalSpendCents = typed ? Math.round(Number(typed) * 100) : undefined;
  if (finalSpendCents !== undefined && !Number.isFinite(finalSpendCents)) {
    return { ok: false, message: "Enter the final spend as a dollar amount." };
  }
  const outcome = await settleAndRefund(ctx, db, publicId, {
    finalSpendCents,
    refundedByHand: formData.get("refundedByHand") === "on",
  });
  refresh(publicId);
  if (!outcome.ok) return { ok: false, message: outcome.message };
  const back = outcome.settlement.refundCents;
  return {
    ok: true,
    message: back > 0 ? `Settled. $${(back / 100).toFixed(2)} refunded and the client told.` : "Settled. Nothing was owed back.",
  };
}
