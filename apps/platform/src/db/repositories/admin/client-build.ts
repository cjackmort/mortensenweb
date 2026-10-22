import { eq } from "drizzle-orm";
import { BUILDS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clients } from "@/db/schema";
import { buildFor } from "@/lib/payments/build";
import type { AdminContext } from "../context";

/**
 * Which website build a client pays for, at what price — set by the operator
 * after the call, read by the cart.
 *
 * The client cannot choose the build: the cart charges exactly what is set
 * here. A quoted price replaces the list price for this client only; leaving
 * it empty charges the list price. Once the build is paid the price is
 * locked, because changing it then would describe a sale that did not happen.
 */

export interface ClientBuildView {
  buildKey: string | null;
  /** What the cart will charge, or null when there is nothing to charge yet. */
  priceCents: number | null;
  quoted: boolean;
  paidAt: Date | null;
}

export async function getClientBuild(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<ClientBuildView | null> {
  const [row] = await db
    .select({ buildKey: clients.buildKey, buildPriceCents: clients.buildPriceCents, paidAt: clients.buildPaidAt })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!row) return null;
  const chosen = buildFor(row);
  return {
    buildKey: chosen?.build.key ?? row.buildKey,
    priceCents: chosen?.priceCents ?? null,
    quoted: chosen?.quoted ?? false,
    paidAt: row.paidAt,
  };
}

/** "350", "350.00", "$1,200" as cents; null for empty; NaN for anything else. */
function parsePrice(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

export async function setClientBuild(
  ctx: AdminContext,
  db: Database,
  input: { clientPublicId: string; buildKey: string; price: string },
): Promise<{ ok: boolean; message: string }> {
  const build = BUILDS.find((b) => b.key === input.buildKey);
  if (!build) return { ok: false, message: "Pick one of the builds listed." };
  const cents = parsePrice(input.price);
  if (cents !== null && Number.isNaN(cents)) return { ok: false, message: "Enter the price in dollars, like 450 or 450.00." };

  const [client] = await db
    .select({ id: clients.id, organizationId: clients.organizationId, paidAt: clients.buildPaidAt })
    .from(clients)
    .where(eq(clients.publicId, input.clientPublicId))
    .limit(1);
  if (!client) return { ok: false, message: "No such client." };
  if (client.paidAt) {
    return { ok: false, message: "Their website is already paid for, so its price can't change." };
  }

  // The list price is stored as "no quote", so a later change to the list
  // price reaches this client too.
  const quoted = cents === null || cents === build.priceCents ? null : cents;
  await db
    .update(clients)
    .set({ buildKey: build.key, buildPriceCents: quoted, updatedAt: new Date() })
    .where(eq(clients.id, client.id));
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "client.build_set",
    entityType: "client",
    entityId: input.clientPublicId,
    metadata: { buildKey: build.key, quotedCents: quoted },
  });

  return { ok: true, message: "Saved. Their cart charges this from now on." };
}
