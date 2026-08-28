import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  organizations,
  paymentRequests,
  payments,
  subscriptions,
} from "@/db/schema";
import { paymentStanding, type PaymentStanding } from "@/lib/billing/dunning";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Money, from the client's side.
 *
 * Everything is scoped through `clients.organization_id = ctx.organizationId`,
 * so there is no code path here that can read or alter another client's
 * invoices.
 *
 * The important behaviour is `declarePaid`. Venmo sends no callback, so there
 * is an unavoidable window between a client paying and the operator confirming
 * it. A client who has said "I sent it" must not receive an overdue reminder
 * during that window — that reminder is wrong, it is about money, and it
 * damages the relationship the agency depends on. `awaiting_confirmation`
 * suppresses the entire dunning ladder, and this is the only place a client can
 * set it.
 *
 * Note what it does NOT do: it does not mark the invoice paid. Only an operator
 * confirming receipt does that. The client's claim and the money arriving are
 * different facts, and the schema keeps them apart.
 */

export interface BillingOverview {
  businessName: string;
  /** The invoice that needs attention, if any. */
  current: {
    publicId: string;
    reference: string;
    amountCents: number;
    currency: string;
    dueOn: string | null;
    status: string;
    note: string | null;
    initiatedAt: Date | null;
  } | null;
  standing: PaymentStanding;
  monthlyPriceCents: number | null;
  history: {
    publicId: string;
    amountCents: number;
    currency: string;
    receivedOn: string;
    method: string;
  }[];
  /** True when the site is still up but our work is paused. */
  managementState: string;
}

export async function getBillingOverview(
  db: Database,
  ctx: TenantContext,
): Promise<BillingOverview> {
  const clientRows = await db
    .select({
      id: clients.id,
      managementState: clients.managementState,
      dunningExemptUntil: clients.dunningExemptUntil,
      businessName: organizations.name,
    })
    .from(clients)
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const client = clientRows[0];
  if (!client) throw new NotFoundError();

  // The invoice that matters is the oldest unsettled one, so a client with two
  // outstanding sees the one they should deal with first.
  //
  // Extra-change purchases are excluded here on purpose: they're a separate,
  // client-initiated top-up with their own card (`ExtraChangePanel`), not the
  // "what do I owe" invoice this section exists to answer. Without this
  // filter, an extra-change request with no due date — the only kind of open
  // request some clients have at a given moment — would surface here
  // mislabelled as the amount due, duplicating what the extra-change panel
  // already shows.
  const openRows = await db
    .select({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      dueOn: paymentRequests.dueOn,
      status: paymentRequests.status,
      note: paymentRequests.note,
      initiatedAt: paymentRequests.initiatedAt,
      dunningStage: paymentRequests.dunningStage,
    })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.clientId, client.id),
        inArray(paymentRequests.status, [
          "open",
          "overdue",
          "awaiting_confirmation",
        ]),
        ne(paymentRequests.purpose, "extra_change"),
      ),
    )
    .orderBy(paymentRequests.dueOn)
    .limit(1);

  const current = openRows[0] ?? null;

  const subRows = await db
    .select({ monthlyPriceCents: subscriptions.monthlyPriceCents })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, client.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .limit(1);

  const history = await db
    .select({
      publicId: payments.publicId,
      amountCents: payments.amountCents,
      currency: payments.currency,
      receivedOn: payments.receivedOn,
      method: payments.method,
    })
    .from(payments)
    .where(
      and(eq(payments.clientId, client.id), eq(payments.status, "recorded")),
    )
    .orderBy(desc(payments.receivedOn))
    .limit(12);

  const standing = paymentStanding(
    {
      status: (current?.status ?? "paid") as never,
      dueOn: current?.dueOn ? new Date(`${current.dueOn}T00:00:00Z`) : null,
      dunningStage: (current?.dunningStage ?? "none") as never,
      exemptUntil: client.dunningExemptUntil,
    },
    new Date(),
  );

  return {
    businessName: client.businessName,
    current,
    standing,
    monthlyPriceCents: subRows[0]?.monthlyPriceCents ?? null,
    history,
    managementState: client.managementState,
  };
}

/**
 * Record that the client opened their payment app.
 *
 * Intent only. This is deliberately NOT a claim that money moved — the schema
 * comment on `initiated_at` says the same thing — so it does not change status
 * and does not suppress reminders. Pressing a button in a browser is not a
 * payment, and treating it as one would stop us chasing an invoice that was
 * never actually paid.
 */
export async function markPaymentInitiated(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
): Promise<void> {
  assertMutable(ctx);

  await db
    .update(paymentRequests)
    .set({ initiatedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(paymentRequests.publicId, requestPublicId),
        // Tenant scope, expressed as a subquery so the update cannot touch
        // another organization's row even if the id were guessed.
        sql`${paymentRequests.clientId} IN (
          SELECT id FROM clients WHERE organization_id = ${ctx.organizationId}
        )`,
        sql`${paymentRequests.initiatedAt} IS NULL`,
      ),
    );
}

export type DeclareResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_declarable" };

/**
 * "I've sent the payment."
 *
 * Moves the invoice to `awaiting_confirmation`, which suppresses the entire
 * reminder ladder until an operator confirms or reverses it. This is the client
 * telling us something we cannot observe, and believing them costs us a few
 * days of delay; disbelieving them costs a wrongly-worded overdue email about
 * money.
 */
export async function declarePaid(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
): Promise<DeclareResult> {
  assertMutable(ctx);

  const claimed = await db
    .update(paymentRequests)
    .set({
      status: "awaiting_confirmation",
      initiatedAt: sql`COALESCE(${paymentRequests.initiatedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentRequests.publicId, requestPublicId),
        sql`${paymentRequests.clientId} IN (
          SELECT id FROM clients WHERE organization_id = ${ctx.organizationId}
        )`,
        // Only an unsettled invoice can be declared. A paid or cancelled one is
        // not something the client should be able to reopen.
        inArray(paymentRequests.status, ["open", "overdue"]),
      ),
    )
    .returning({ id: paymentRequests.id });

  return claimed.length > 0
    ? { ok: true }
    : { ok: false, reason: "not_declarable" };
}
