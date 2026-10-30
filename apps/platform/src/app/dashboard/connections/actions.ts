"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { completeConnect, disconnect, runAudit, runOwnAudit } from "@/db/repositories/client/connections";
import { isConnectionProvider, providerAdapter } from "@/lib/connections";
import { ProviderError } from "@/lib/connections/types";

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

  let gone: boolean;
  try {
    gone = await disconnect(session.db, session.ctx, provider);
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, message: READ_ONLY };
    throw error;
  }
  if (!gone) return { ok: false, message: "That account was not connected." };

  // The buttons this message would sit under go with the connected card, so
  // the outcome goes to the page's notice instead, where it survives the redraw.
  revalidatePath("/dashboard/connections");
  redirect(`/dashboard/connections?connect=${provider}:disconnected`);
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

/**
 * Connect a provider that takes a key rather than a sign-in: Stripe's
 * restricted key. Same rule as the sign-in routes: the client's own grant,
 * never made while an operator views as them. The key is checked and read
 * with once before it is kept, sealed; it is never sent back, logged or
 * stored anywhere but the sealed column.
 */
export async function connectKeyAction(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const user = await currentUser();
  if (!user?.organizationId) return { ok: false, message: "Please sign in again." };
  if (user.role !== "client" || user.viewingAs) return { ok: false, message: READ_ONLY };
  const provider = String(formData.get("provider") ?? "");
  if (!isConnectionProvider(provider)) return { ok: false, message: "Unknown account." };
  const adapter = providerAdapter(provider);
  if (adapter.connectWith !== "key") return { ok: false, message: `${adapter.name} connects by signing in, not with a key.` };
  if (!adapter.configured().ok) return { ok: false, message: "That account can't be connected yet. We will switch it on and let you know." };

  let grant;
  try {
    grant = await adapter.acceptKey(String(formData.get("key") ?? ""));
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "invalid") return { ok: false, message: error.message };
    console.error("[connections] key check failed", {
      provider,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: `${adapter.name} couldn't be reached just now. Try again in a minute.` };
  }

  const db = await getDb();
  const ctx = tenantContextFrom(user, user.organizationId);
  try {
    await completeConnect(db, ctx, provider, grant);
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, message: READ_ONLY };
    throw error;
  }

  const first = await runAudit(db, ctx.organizationId, provider);
  revalidatePath("/dashboard/connections");
  redirect(`/dashboard/connections?connect=${provider}:${first.ok ? "connected" : "connected_unread"}`);
}
