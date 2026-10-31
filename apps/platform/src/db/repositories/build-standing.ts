import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, paymentRequests } from "@/db/schema";
import { derivedPublicId } from "@/lib/ids";

/**
 * Whether a client still owes for their website — decision D1's one question.
 *
 * Read by the welcome page (what to charge), by the unlock (change requests
 * open on the build, not on any payment), and by the two launch steps (no
 * domain connected and nothing live until the build is settled). One function,
 * because those drifting apart is how a client gets let in, or put live, by
 * one rule while another still asks them for $500.
 *
 * Not tenant-scoped: it takes a client id the caller has already resolved,
 * from a session or an operator's page.
 */

export type BuildStanding =
  | { settled: true; reason: "paid" | "complimentary" | "internal" | "waived" }
  | { settled: false };

export interface BuildFacts {
  clientId: string;
  compPlanId: string | null;
  isInternal: boolean;
  buildPaidAt: Date | null;
  freeBuildOn: string | null;
}

const WAIVED_INVOICE = ["cancelled", "written_off"];

/**
 * The build invoice the welcome checkout raises: the same public id every
 * time for the same client, so the unique index on `public_id` keeps it to one
 * however many times the button is pressed.
 */
export function buildInvoicePublicId(clientId: string): Promise<string> {
  return derivedPublicId(`website-build:${clientId}`);
}

/**
 * Whether paying this invoice pays for the build: one raised for the build
 * (`purpose = 'build'`), or the welcome checkout's own, which before 0047 was
 * raised as `other` and is recognised by its derived id.
 */
export async function isBuildInvoice(request: { publicId: string; clientId: string; purpose: string }): Promise<boolean> {
  if (request.purpose === "build") return true;
  return request.publicId === (await buildInvoicePublicId(request.clientId));
}

/**
 * In order: on the house; the agency's own; paid; and waived — a free build
 * the operator recorded, or the welcome build invoice cancelled or written
 * off. Anything else owes the build.
 */
export async function buildStandingFor(db: Database, client: BuildFacts): Promise<BuildStanding> {
  if (client.compPlanId) return { settled: true, reason: "complimentary" };
  if (client.isInternal) return { settled: true, reason: "internal" };
  if (client.buildPaidAt) return { settled: true, reason: "paid" };
  if (client.freeBuildOn) return { settled: true, reason: "waived" };

  const [invoice] = await db
    .select({ status: paymentRequests.status })
    .from(paymentRequests)
    .where(eq(paymentRequests.publicId, await buildInvoicePublicId(client.clientId)))
    .limit(1);
  if (invoice && WAIVED_INVOICE.includes(invoice.status)) return { settled: true, reason: "waived" };

  return { settled: false };
}

export const BUILD_FACT_COLUMNS = {
  clientId: clients.id,
  compPlanId: clients.compPlanId,
  isInternal: clients.isInternal,
  buildPaidAt: clients.buildPaidAt,
  freeBuildOn: clients.freeBuildOn,
};

/** `buildStandingFor`, reading the client first. Unsettled for a client that does not exist. */
export async function buildStandingOf(db: Database, clientId: string): Promise<BuildStanding> {
  const [row] = await db.select(BUILD_FACT_COLUMNS).from(clients).where(eq(clients.id, clientId)).limit(1);
  return row ? buildStandingFor(db, row) : { settled: false };
}

export type BuildPaidSource =
  /** Its line on a settled Stripe invoice, a 100%-off line included. */
  | "stripe_invoice"
  /** Its invoice settled: by a Stripe checkout, or an operator's Mark paid. */
  | "invoice_paid"
  /** An operator recording money that came in with no invoice, as the build. */
  | "manual_payment";

/**
 * Record that the build is paid. First write wins, so a replayed event or a
 * second confirmation keeps the original date; returns whether this call is
 * the one that recorded it.
 *
 * Only the fact. What follows from it — unlocking change requests — is the
 * caller's `unlockClientFeatures`, which now reads this.
 */
export async function markBuildPaid(
  db: Database,
  clientId: string,
  input: { source: BuildPaidSource; actorUserId?: string | null; reference?: string | null; amountCents?: number },
): Promise<boolean> {
  const now = new Date();
  const marked = await db
    .update(clients)
    .set({ buildPaidAt: now, updatedAt: now })
    .where(and(eq(clients.id, clientId), isNull(clients.buildPaidAt)))
    .returning({ publicId: clients.publicId, organizationId: clients.organizationId });

  const row = marked[0];
  if (!row) return false;

  await db.insert(auditLog).values({
    actorUserId: input.actorUserId ?? null,
    organizationId: row.organizationId,
    action: "build.paid",
    entityType: "client",
    entityId: row.publicId,
    metadata: {
      source: input.source,
      reference: input.reference ?? null,
      amountCents: input.amountCents ?? null,
    },
  });
  return true;
}
