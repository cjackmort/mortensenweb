"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { disconnect, runOwnAudit } from "@/db/repositories/client/connections";
import { isConnectionProvider, providerAdapter } from "@/lib/connections";

export type ConnectionActionResult = { ok: boolean; message: string };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId) return null;
  return { user, db: await getDb(), ctx: tenantContextFrom(user, user.organizationId) };
}

const READ_ONLY = "You are viewing this portal as the client, so connections can't be changed.";

export async function disconnectAction(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };
  const provider = String(formData.get("provider") ?? "");
  if (!isConnectionProvider(provider)) return { ok: false, message: "Unknown account." };

  try {
    const gone = await disconnect(session.db, session.ctx, provider);
    revalidatePath("/dashboard/connections");
    return gone
      ? { ok: true, message: `${providerAdapter(provider).name} is disconnected. Nothing from it will be in your next report.` }
      : { ok: false, message: "That account was not connected." };
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, message: READ_ONLY };
    throw error;
  }
}

export async function auditNowAction(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };
  const provider = String(formData.get("provider") ?? "");
  if (!isConnectionProvider(provider)) return { ok: false, message: "Unknown account." };

  try {
    const run = await runOwnAudit(session.db, session.ctx, provider);
    revalidatePath("/dashboard/connections");
    return run.ok ? { ok: true, message: `Looked just now: ${run.audit.headline}.` } : { ok: false, message: run.message };
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, message: READ_ONLY };
    throw error;
  }
}
