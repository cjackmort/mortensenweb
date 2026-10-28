"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { takeOwnSearchSnapshot } from "@/db/repositories/client/search-snapshots";

/**
 * The client's one write on this page: asking for today's figures now
 * rather than waiting for the scheduled look. The tenant comes from the
 * session, never the form, and the repository refuses while an operator is
 * viewing as the client.
 */

export type RefreshResult = { ok: boolean; message: string };

export async function refreshSearchAction(_previous: RefreshResult | null): Promise<RefreshResult> {
  const user = await currentUser();
  if (!user?.organizationId) return { ok: false, message: "Please sign in again." };
  const ctx = tenantContextFrom(user, user.organizationId);

  try {
    const run = await takeOwnSearchSnapshot(await getDb(), ctx);
    revalidatePath("/dashboard/growth/search");
    if (run.ok) return { ok: true, message: "Read from Google just now." };
    return { ok: false, message: run.message };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, message: "You are viewing this portal as the client, so this can't be run." };
    }
    console.error("[search] refresh failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}
