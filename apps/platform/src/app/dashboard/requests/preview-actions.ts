"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { nudgeScheduler } from "@/lib/scheduler/nudge";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  findJobForRequest,
  recordPreviewDecision,
} from "@/db/repositories/client/previews";
import { applyApprovedChange } from "@/db/repositories/admin/merge";

/**
 * "I like it — put it live."
 *
 * One click by a client, two distinct steps underneath, and the order matters:
 *
 *  1. **Record the decision.** This must always succeed and always be stored.
 *     It is the client's act, and it is what a later "did they approve this?"
 *     question is answered from.
 *  2. **Attempt the merge.** This can legitimately be refused — checks still
 *     running, new commits pushed, a diff that strayed outside scope.
 *
 * If these were one operation, a guard refusal would roll back the approval and
 * the client would click Apply, see nothing happen, and click again. Keeping
 * them separate means a refusal reads as "approved, held for a moment" rather
 * than "your click did not work".
 *
 * The tenant is resolved from the session here, before anything touches a
 * repository. Nothing a client submits selects which repository is written to —
 * the only input is which of *their own* requests they are responding to.
 */

export type ApplyResult =
  | { ok: true; live: boolean; message: string }
  | { ok: false; message: string };

/**
 * Explicitly discriminated on `ok`.
 *
 * Without the annotation TypeScript normalises the union into members carrying
 * `error?: undefined`, and an optional property defeats `in`-narrowing — so the
 * success branch would still be typed as possibly having an error.
 */
type ResolvedTenant =
  | { ok: false; error: string }
  | { ok: true; ctx: ReturnType<typeof tenantContextFrom> };

async function tenantFromSession(): Promise<ResolvedTenant> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      error: "Your account is not linked to an organization yet.",
    };
  }
  return { ok: true, ctx: tenantContextFrom(user, user.organizationId) };
}

export async function approveAndApply(
  _previous: ApplyResult | null,
  formData: FormData,
): Promise<ApplyResult> {
  const resolved = await tenantFromSession();
  if (!resolved.ok) return { ok: false, message: resolved.error };

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  if (!requestPublicId) return { ok: false, message: "No request was specified." };

  const db = await getDb();

  const decision = await recordPreviewDecision(
    db,
    resolved.ctx,
    requestPublicId,
    "approved",
  );

  revalidatePath("/dashboard/requests");
  // The dashboard shows the approval banner, so it is stale the moment a
  // decision is recorded. Without this the client approves, navigates back,
  // and Next serves the router-cached page still asking them to review it.
  revalidatePath("/dashboard");

  if (!decision.ok) return { ok: false, message: decision.message };

  // Re-read rather than trusting the decision's own view of the job: the
  // repository details come from the database, never from the form.
  const job = await findJobForRequest(db, resolved.ctx, requestPublicId);
  if (!job) {
    return {
      ok: true,
      live: false,
      message: "Thanks — we've recorded your approval and we'll take it from here.",
    };
  }

  const outcome = await applyApprovedChange(db, {
    agentJobId: job.id,
    approvedHeadSha: decision.headSha,
    actorUserId: resolved.ctx.userId,
  });

  revalidatePath("/dashboard/requests");
  // The dashboard shows the approval banner, so it is stale the moment a
  // decision is recorded. Without this the client approves, navigates back,
  // and Next serves the router-cached page still asking them to review it.
  revalidatePath("/dashboard");

  if (!outcome.ok) {
    // Their approval *is* recorded, so this is not a failure of their action.
    // Saying "we've held it" rather than "that didn't work" is both truer and
    // less alarming.
    return { ok: true, live: false, message: outcome.message };
  }

  // The merge is done; confirming the deploy and the live site is the
  // scheduler's job. Nudging it now turns "confirmed live" from a
  // five-minute wait into a short one.
  nudgeScheduler("change approved");

  return { ok: true, live: true, message: outcome.message };
}

export async function requestMoreChanges(
  _previous: ApplyResult | null,
  formData: FormData,
): Promise<ApplyResult> {
  const resolved = await tenantFromSession();
  if (!resolved.ok) return { ok: false, message: resolved.error };

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!requestPublicId) return { ok: false, message: "No request was specified." };

  const db = await getDb();

  const decision = await recordPreviewDecision(
    db,
    resolved.ctx,
    requestPublicId,
    "changes_requested",
    note,
  );

  revalidatePath("/dashboard/requests");
  // The dashboard shows the approval banner, so it is stale the moment a
  // decision is recorded. Without this the client approves, navigates back,
  // and Next serves the router-cached page still asking them to review it.
  revalidatePath("/dashboard");

  if (!decision.ok) return { ok: false, message: decision.message };

  // Note that this does *not* spend another change from the allowance. Asking
  // for a correction to work we have not yet delivered is part of the same
  // change, and charging for it would make clients reluctant to say when
  // something is not right — which produces worse websites.
  return {
    ok: true,
    live: false,
    message: "Thanks — we'll make those adjustments and send you a new preview.",
  };
}
