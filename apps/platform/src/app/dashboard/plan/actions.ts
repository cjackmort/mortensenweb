"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  addGrowthAddOn,
  changeMyPlan,
  removeGrowthAddOn,
  setPlanCancellation,
  type ChangeResult,
} from "@/db/repositories/client/growth";

/**
 * Plan and add-on changes a client makes themselves. Each re-derives the
 * tenant from the session; the form only ever names a plan or a feature, and
 * the subscription it applies to is found from the session's organization.
 */

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  return { ctx: tenantContextFrom(user, user.organizationId), db: await getDb() };
}

const SIGN_IN: ChangeResult = { ok: false, message: "Please sign in again." };

function refresh() {
  // "layout": the Growth tab, the Plan tab and the inbox all read access.
  revalidatePath("/dashboard", "layout");
}

export async function addAddOnAction(_p: ChangeResult | null, form: FormData): Promise<ChangeResult> {
  const s = await context();
  if (!s) return SIGN_IN;
  const result = await addGrowthAddOn(s.db, s.ctx, String(form.get("feature") ?? ""));
  if (result.ok) refresh();
  return result;
}

export async function removeAddOnAction(_p: ChangeResult | null, form: FormData): Promise<ChangeResult> {
  const s = await context();
  if (!s) return SIGN_IN;
  const result = await removeGrowthAddOn(s.db, s.ctx, String(form.get("feature") ?? ""));
  if (result.ok) refresh();
  return result;
}

export async function changePlanAction(_p: ChangeResult | null, form: FormData): Promise<ChangeResult> {
  const s = await context();
  if (!s) return SIGN_IN;
  const result = await changeMyPlan(s.db, s.ctx, String(form.get("plan") ?? ""));
  if (result.ok) refresh();
  return result;
}

export async function cancellationAction(_p: ChangeResult | null, form: FormData): Promise<ChangeResult> {
  const s = await context();
  if (!s) return SIGN_IN;
  const result = await setPlanCancellation(s.db, s.ctx, form.get("cancel") === "1");
  if (result.ok) refresh();
  return result;
}
