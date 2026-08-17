"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  dispatchBrief,
  organizationForClient,
  saveBrief,
} from "@/db/repositories/admin/briefs";

/**
 * The post-call brief.
 *
 * The operator finishes a call, types what the client asked for, and presses a
 * button. Two buttons, in fact, and the difference matters:
 *
 *  - **Save** parks it. Calls run long and notes get typed in pieces; being
 *    unable to save without also starting an automated build of someone's
 *    website is the kind of design that makes people keep notes somewhere else.
 *  - **Save and build** submits and dispatches in one step, which is the
 *    common case at the end of a call.
 *
 * Dispatch failures come back as messages rather than exceptions. "No
 * repository connected", "not allowlisted", "daily cap reached" are all normal
 * operational states with a next action, not crashes.
 */

export type BriefResult =
  | { ok: true; message: string; issueUrl?: string }
  | { ok: false; message: string };

export async function saveBriefAction(
  _previous: BriefResult | null,
  formData: FormData,
): Promise<BriefResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (user.role !== "admin") {
    return { ok: false, message: "Only an admin can write a brief." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client was specified." };

  const dispatchNow = formData.get("intent") === "build";
  const ctx = adminContextFrom(user);
  const db = await getDb();

  const organizationId = await organizationForClient(db, clientPublicId);

  const saved = await saveBrief(
    ctx,
    db,
    {
      organizationId,
      sitePublicId: String(formData.get("sitePublicId") ?? "").trim() || undefined,
      kind:
        String(formData.get("kind") ?? "revision") === "discovery"
          ? "discovery"
          : "revision",
      colourDirection: String(formData.get("colourDirection") ?? ""),
      features: String(formData.get("features") ?? ""),
      contentNotes: String(formData.get("contentNotes") ?? ""),
      body: String(formData.get("body") ?? ""),
    },
    // Dispatching requires a submitted brief, so "build" implies "submit".
    { submit: dispatchNow },
  );

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!saved.ok) return { ok: false, message: saved.message };

  if (!dispatchNow) {
    return { ok: true, message: "Brief saved as a draft." };
  }

  const outcome = await dispatchBrief(ctx, db, saved.publicId);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!outcome.ok) {
    // The brief itself was saved. Saying so matters — otherwise the operator
    // assumes their typing was lost and types it again.
    return {
      ok: false,
      message: `Brief saved, but it could not be sent to the agent: ${outcome.message}`,
    };
  }

  return {
    ok: true,
    message: `Brief sent — issue #${outcome.issueNumber} opened. A preview will follow shortly.`,
    issueUrl: outcome.issueUrl,
  };
}

/** Dispatch a brief that was previously saved as a draft. */
export async function dispatchBriefAction(
  _previous: BriefResult | null,
  formData: FormData,
): Promise<BriefResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (user.role !== "admin") {
    return { ok: false, message: "Only an admin can start automated work." };
  }

  const briefPublicId = String(formData.get("briefPublicId") ?? "").trim();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!briefPublicId) return { ok: false, message: "No brief was specified." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const outcome = await dispatchBrief(ctx, db, briefPublicId);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: `Brief sent — issue #${outcome.issueNumber} opened.`,
    issueUrl: outcome.issueUrl,
  };
}
