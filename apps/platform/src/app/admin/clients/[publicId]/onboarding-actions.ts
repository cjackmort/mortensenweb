"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { sendDemoInvite, setDemoUrl } from "@/db/repositories/admin/onboarding";

/**
 * The demo URL and the demo email. A server action is a public POST
 * endpoint, so each re-derives the admin context from the session.
 */

export type OnboardingResult = { ok: boolean; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export async function setDemoUrlAction(_previous: OnboardingResult | null, form: FormData): Promise<OnboardingResult> {
  const ctx = await requireAdmin();
  const clientPublicId = String(form.get("clientPublicId") ?? "");
  const result = await setDemoUrl(ctx, await getDb(), {
    clientPublicId,
    demoUrl: String(form.get("demoUrl") ?? ""),
  });
  if (result.ok) revalidatePath(`/admin/clients/${clientPublicId}`);
  return result;
}

export async function sendDemoInviteAction(
  _previous: OnboardingResult | null,
  form: FormData,
): Promise<OnboardingResult> {
  const ctx = await requireAdmin();
  const clientPublicId = String(form.get("clientPublicId") ?? "");
  const result = await sendDemoInvite(ctx, await getDb(), {
    clientPublicId,
    to: String(form.get("to") ?? ""),
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
  });
  if (result.ok) revalidatePath(`/admin/clients/${clientPublicId}`);
  return result;
}
