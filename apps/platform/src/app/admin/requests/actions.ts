"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  closeChangeRequest,
  dispatchChangeRequest,
} from "@/db/repositories/admin/agent-jobs";

/**
 * Starting automated work on a request.
 *
 * The operator-facing half of the pipeline. Everything that could refuse the
 * dispatch — wrong status, no connected repository, repository not allowlisted,
 * daily cap reached, GitHub unreachable — comes back as a message rather than
 * an exception, because each of those is a normal operational state the admin
 * needs explained, not a crash.
 *
 * Nothing here reads the Claude credential. The portal opens an issue; the
 * workflow in the client's repository is what runs Claude, and its token lives
 * only in GitHub Actions secrets.
 */

export type DispatchResult =
  | { ok: true; message: string; issueUrl: string }
  | { ok: false; message: string };

export async function startAutomatedWork(
  _previous: DispatchResult | null,
  formData: FormData,
): Promise<DispatchResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (user.role !== "admin") {
    return { ok: false, message: "Only an admin can start automated work." };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  if (!requestPublicId) {
    return { ok: false, message: "No request was specified." };
  }

  // Optional narrowing. When the operator lists paths, they bound both what the
  // agent is told to touch and what the merge guard will accept afterwards.
  const rawPaths = String(formData.get("allowedPaths") ?? "").trim();
  const allowedPaths = rawPaths
    ? rawPaths
        .split(/[\n,]/)
        .map((path) => path.trim())
        .filter(Boolean)
    : undefined;

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const outcome = await dispatchChangeRequest(ctx, db, {
    requestPublicId,
    allowedPaths,
  });

  revalidatePath("/admin/requests");

  if (!outcome.ok) {
    return { ok: false, message: outcome.message };
  }

  return {
    ok: true,
    message: `Work started — issue #${outcome.issueNumber} opened.`,
    issueUrl: outcome.issueUrl,
  };
}

/**
 * Close a request without carrying it out.
 *
 * Tests, duplicates, things raised by mistake. The opposite decision from
 * dispatch, so a separate action — and the repository refuses anything already
 * in flight, because closing here would not stop the work, only stop anyone
 * watching for it.
 */
export type CloseResult = { ok: boolean; message: string };

export async function closeRequestAction(
  _previous: CloseResult | null,
  formData: FormData,
): Promise<CloseResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can close a request." };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!requestPublicId) return { ok: false, message: "No request specified." };

  const db = await getDb();
  const outcome = await closeChangeRequest(
    adminContextFrom(user),
    db,
    requestPublicId,
    reason,
  );

  revalidatePath("/admin/requests");

  if (!outcome.ok) {
    return {
      ok: false,
      message:
        outcome.reason === "in_flight"
          ? "The agent is already working on this one. Let it finish, or cancel the run on GitHub."
          : "No such request.",
    };
  }

  return { ok: true, message: "Closed." };
}
