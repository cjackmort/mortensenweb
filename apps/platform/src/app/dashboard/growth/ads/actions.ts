"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ADS_AVAILABLE, isAdChannelKey, type AdChannelKey } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import {
  createDraftCampaign,
  discardDraft,
  resubmitCampaign,
  saveChannels,
  saveCreative,
  type ChannelsOutcome,
} from "@/db/repositories/client/ads";
import { beginAdCheckout, reopenCampaign } from "@/db/repositories/client/ad-checkout";
import { parseCreativeForm } from "@/lib/ads/creative";
import type { ChannelBudget } from "@/lib/ads/money";

/**
 * Creating and paying for an ad. Every action finds the client from the
 * session, and every campaign inside that client; the form only ever names a
 * campaign's public id.
 */

const BASE = "/dashboard/growth/ads";

async function tenant() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");
  return { ctx: tenantContextFrom(user, user.organizationId), db: await getDb() };
}

function campaignId(formData: FormData): string {
  const value = formData.get("campaign");
  if (typeof value !== "string" || !/^[0-9A-Z]{26}$/.test(value)) throw new NotFoundError();
  return value;
}

/** "Create ad": draft it and open the editor. */
export async function createAdAction(): Promise<void> {
  if (!ADS_AVAILABLE) redirect(BASE);
  const { ctx, db } = await tenant();
  const { publicId, missing } = await createDraftCampaign(db, ctx);
  revalidatePath(BASE);
  redirect(`${BASE}/${publicId}/edit${missing.length ? `?missing=${missing.join(",")}` : ""}`);
}

export type CreativeState = { saved: boolean; problems: string[]; message?: string };

export async function saveCreativeAction(_previous: CreativeState | null, formData: FormData): Promise<CreativeState> {
  const { ctx, db } = await tenant();
  const publicId = campaignId(formData);
  const outcome = await saveCreative(db, ctx, publicId, parseCreativeForm(formData));
  if (!outcome.ok) return { saved: false, problems: [], message: outcome.message };

  revalidatePath(`${BASE}/${publicId}`);
  const intent = formData.get("intent");
  if (intent === "resubmit") {
    const sent = await resubmitCampaign(db, ctx, publicId);
    if (!sent.ok) return { saved: true, problems: outcome.problems, message: sent.message };
    redirect(`${BASE}/${publicId}`);
  }
  if (intent === "continue" && outcome.problems.length === 0) {
    redirect(`${BASE}/${publicId}/channels`);
  }
  return { saved: true, problems: outcome.problems };
}

/** `budget_google_search=300` etc., in whole dollars, for each ticked channel. */
function readChannels(formData: FormData): ChannelBudget[] {
  return formData
    .getAll("channel")
    .filter((value): value is AdChannelKey => isAdChannelKey(value))
    .map((channel) => {
      const dollars = Number(String(formData.get(`budget_${channel}`) ?? "").replace(/[$,\s]/g, ""));
      return { channel, budgetCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0 };
    });
}

export type ChannelsState = { errors: Extract<ChannelsOutcome, { ok: false }>["errors"] } | null;

export async function saveChannelsAction(_previous: ChannelsState, formData: FormData): Promise<ChannelsState> {
  const { ctx, db } = await tenant();
  const publicId = campaignId(formData);
  const outcome = await saveChannels(db, ctx, publicId, {
    channels: readChannels(formData),
    days: Number(formData.get("days")),
    startsOn: String(formData.get("startsOn") ?? ""),
  });
  if (!outcome.ok) return { errors: outcome.errors };

  revalidatePath(`${BASE}/${publicId}`);
  redirect(`${BASE}/${publicId}/checkout`);
}

export type PayState = { message: string } | null;

export async function startAdCheckoutAction(_previous: PayState, formData: FormData): Promise<PayState> {
  const { ctx, db } = await tenant();
  const publicId = campaignId(formData);

  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!base) return { message: "Payments are not fully set up yet. Please get in touch." };

  const outcome = await beginAdCheckout(db, ctx, publicId, {
    // `?paid=1` only changes wording. The campaign moves on when the webhook
    // confirms the money, never because someone arrived at this address.
    successUrl: `${base}${BASE}/${publicId}?paid=1`,
    cancelUrl: `${base}${BASE}/${publicId}/checkout`,
  });
  revalidatePath(`${BASE}/${publicId}`);

  if (!outcome.ok) return { message: outcome.message };
  redirect(outcome.url);
}

export async function reopenAdAction(_previous: PayState, formData: FormData): Promise<PayState> {
  const { ctx, db } = await tenant();
  const publicId = campaignId(formData);
  const outcome = await reopenCampaign(db, ctx, publicId);
  if (!outcome.ok) return { message: outcome.message };

  revalidatePath(`${BASE}/${publicId}`);
  redirect(`${BASE}/${publicId}/edit`);
}

export async function discardAdAction(formData: FormData): Promise<void> {
  const { ctx, db } = await tenant();
  await discardDraft(db, ctx, campaignId(formData));
  revalidatePath(BASE);
  redirect(BASE);
}
