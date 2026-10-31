"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { archiveClient, restoreClient } from "@/db/repositories/admin/clients";
import { REMOVE_REFUSALS } from "./remove-copy";

/**
 * Remove (archive) a client, and bring one back.
 *
 * Both re-derive the admin context from the session: a server action is a
 * public POST endpoint, and the page's role check protects the page, not this.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type RemoveClientResult = { ok: false; message: string } | null;

function refreshClientLists() {
  revalidatePath("/admin/clients");
  revalidatePath("/admin");
}

/**
 * Remove a client from the Clients list. Success redirects to the list with
 * `?removed=<id>`, which shows a notice with Restore — so removing is undoable
 * from the page it lands on, and the focused button that no longer exists has
 * somewhere for focus to go.
 */
export async function removeClientAction(
  _previous: RemoveClientResult,
  formData: FormData,
): Promise<RemoveClientResult> {
  const ctx = await requireAdmin();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client specified." };

  const outcome = await archiveClient(ctx, await getDb(), clientPublicId);
  if (!outcome.ok) {
    // A stale tile (removed in another tab) is cleared by the refresh.
    refreshClientLists();
    return { ok: false, message: REMOVE_REFUSALS[outcome.reason] };
  }

  refreshClientLists();
  revalidatePath(`/admin/clients/${clientPublicId}`);
  redirect(`/admin/clients?removed=${encodeURIComponent(clientPublicId)}`);
}

/** Put a removed client back on the Clients list. */
export async function restoreClientAction(formData: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();

  // Restoring one that is not removed (a double click, another tab) lands in
  // the same place: the list, with them on it.
  if (clientPublicId) await restoreClient(ctx, await getDb(), clientPublicId);

  refreshClientLists();
  revalidatePath(`/admin/clients/${clientPublicId}`);
  redirect("/admin/clients");
}
