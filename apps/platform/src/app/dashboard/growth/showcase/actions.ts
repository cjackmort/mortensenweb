"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  approveShowcase,
  createShowcase,
  deleteShowcase,
  markPostedToGoogle,
  saveShowcaseWording,
  sendShowcaseToSite,
} from "@/db/repositories/client/showcases";

/**
 * Showcase mutations. Each re-derives the tenant from the session — a server
 * action is a public POST endpoint, and the ids in the form are only ever
 * looked up inside the caller's own organization — and each checks the
 * feature, because the page being locked does not stop a POST.
 */

export type ShowcaseActionResult = { ok: true; message: string } | { ok: false; message: string };

const SIGN_IN_AGAIN: ShowcaseActionResult = { ok: false, message: "Please sign in again." };
const NOT_IN_PLAN: ShowcaseActionResult = {
  ok: false,
  message: "Your plan does not include Job showcase. See Growth to add it.",
};
const GONE: ShowcaseActionResult = { ok: false, message: "That showcase no longer exists." };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "showcase"))) return "locked" as const;
  return { ctx, db };
}

function refresh(publicId?: string) {
  revalidatePath("/dashboard/growth/showcase");
  if (publicId) revalidatePath(`/dashboard/growth/showcase/${publicId}`);
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function wording(formData: FormData) {
  return { title: text(formData, "title"), writeUp: text(formData, "writeUp"), caption: text(formData, "caption") };
}

export async function createShowcaseAction(
  _previous: ShowcaseActionResult | null,
  formData: FormData,
): Promise<ShowcaseActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;
  if (session === "locked") return NOT_IN_PLAN;

  const result = await createShowcase(session.db, session.ctx, {
    job: text(formData, "job"),
    town: text(formData, "town"),
    notes: text(formData, "notes"),
    sitePublicId: text(formData, "sitePublicId"),
    photoPublicIds: formData.getAll("photo").map(String),
    beforePublicId: text(formData, "before"),
    afterPublicId: text(formData, "after"),
  });
  if (!result.ok) return result;

  refresh();
  redirect(`/dashboard/growth/showcase/${result.publicId}`);
}

export async function saveWordingAction(
  _previous: ShowcaseActionResult | null,
  formData: FormData,
): Promise<ShowcaseActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;
  if (session === "locked") return NOT_IN_PLAN;

  const publicId = text(formData, "showcase");
  const intent = text(formData, "intent");
  try {
    const result =
      intent === "approve"
        ? await approveShowcase(session.db, session.ctx, publicId, wording(formData))
        : await saveShowcaseWording(session.db, session.ctx, publicId, wording(formData));
    refresh(publicId);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return GONE;
    throw error;
  }
}

export async function sendToSiteAction(
  _previous: ShowcaseActionResult | null,
  formData: FormData,
): Promise<ShowcaseActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;
  if (session === "locked") return NOT_IN_PLAN;

  const publicId = text(formData, "showcase");
  try {
    const result = await sendShowcaseToSite(session.db, session.ctx, publicId);
    refresh(publicId);
    revalidatePath("/dashboard/requests");
    return result.ok ? result : { ok: false, message: result.message };
  } catch (error) {
    if (error instanceof NotFoundError) return GONE;
    throw error;
  }
}

export async function markPostedAction(
  _previous: ShowcaseActionResult | null,
  formData: FormData,
): Promise<ShowcaseActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;
  if (session === "locked") return NOT_IN_PLAN;

  const publicId = text(formData, "showcase");
  try {
    await markPostedToGoogle(session.db, session.ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) return GONE;
    throw error;
  }
  refresh(publicId);
  return { ok: true, message: "Marked as posted." };
}

export async function deleteShowcaseAction(formData: FormData): Promise<void> {
  const session = await context();
  if (!session || session === "locked") redirect("/dashboard/growth");

  try {
    await deleteShowcase(session.db, session.ctx, text(formData, "showcase"));
  } catch (error) {
    // Already gone is the outcome they asked for.
    if (!(error instanceof NotFoundError)) throw error;
  }
  refresh();
  redirect("/dashboard/growth/showcase?deleted=1");
}
