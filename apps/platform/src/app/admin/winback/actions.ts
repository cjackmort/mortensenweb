"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { haltAllWinback, haltCampaign } from "@/db/repositories/admin/winback";

/** The operator's kill switches. Each re-checks the admin role: an action is a public POST. */

export type HaltActionResult = { ok: true; message: string } | { ok: false; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

function reasonOf(formData: FormData): string {
  const raw = formData.get("reason");
  return typeof raw === "string" ? raw : "";
}

export async function haltCampaignAction(_previous: HaltActionResult | null, formData: FormData): Promise<HaltActionResult> {
  const ctx = await requireAdmin();
  const campaign = formData.get("campaign");
  if (typeof campaign !== "string" || !campaign) return { ok: false, message: "Which campaign?" };
  const result = await haltCampaign(ctx, await getDb(), campaign, reasonOf(formData));
  revalidatePath("/admin/winback");
  return result;
}

export async function haltAllAction(_previous: HaltActionResult | null, formData: FormData): Promise<HaltActionResult> {
  const ctx = await requireAdmin();
  if (formData.get("confirm") !== "STOP") return { ok: false, message: "Type STOP to confirm." };
  const { halted } = await haltAllWinback(ctx, await getDb(), reasonOf(formData));
  revalidatePath("/admin/winback");
  return {
    ok: true,
    message: halted === 0 ? "Nothing was scheduled or sending." : `Stopped ${halted} ${halted === 1 ? "campaign" : "campaigns"}.`,
  };
}
