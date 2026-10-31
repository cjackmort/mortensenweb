import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { clients, notifications, organizations } from "@/db/schema";
import { buildPaymentReminderEmail } from "@/lib/email/payment-reminder";
import { sendEmail } from "@/lib/email/mailer";
import { newPublicId } from "@/lib/ids";

/**
 * Telling a client their card payment did not go through.
 *
 * Stripe retries a failed charge on its own schedule, and until now the
 * portal said nothing: the first a client heard was the dunning ladder weeks
 * later, or nothing at all. One email, the first rung's tone — nothing about
 * the site changes — with a link to Stripe's page for the invoice, where
 * another card can be used.
 *
 * ## Once per invoice
 *
 * Stripe sends `invoice.payment_failed` for every retry. The `notifications`
 * row, keyed `payment_failed:<invoice>`, is claimed before sending, so a
 * redelivered event or the next retry finds it and sends nothing. A send the
 * mailer skipped for want of an API key releases the claim, the same rule the
 * mailer follows: never recorded as sent when it was only logged.
 *
 * ## Who is not emailed
 *
 * The settings the dunning ladder already honours: a client an operator
 * exempted from reminders (`dunning_exempt_until`), the agency's own site, and
 * demo clients. Recorded as `suppressed`, so it is visible why no email went.
 */

export type FailedPaymentEmailOutcome =
  | "sent"
  | "already_sent"
  | "suppressed"
  | "no_contact"
  | "no_api_key"
  | "failed";

const KIND = "payment_failed";

async function record(
  db: Database,
  input: { organizationId: string; clientId: string; dedupeKey: string; status: "pending" | "suppressed" | "failed"; error?: string },
): Promise<boolean> {
  const inserted = await db
    .insert(notifications)
    .values({
      publicId: newPublicId(),
      organizationId: input.organizationId,
      kind: KIND,
      subjectType: "client",
      subjectId: input.clientId,
      channel: "email",
      status: input.status,
      dedupeKey: input.dedupeKey,
      error: input.error ?? null,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  return inserted.length > 0;
}

export async function emailFailedCardPayment(
  db: Database,
  match: { clientId: string; organizationId: string },
  invoice: Stripe.Invoice,
  now: Date = new Date(),
): Promise<FailedPaymentEmailOutcome> {
  const dedupeKey = `${KIND}:${invoice.id}`;

  const [client] = await db
    .select({
      contactName: clients.primaryContactName,
      contactEmail: clients.primaryContactEmail,
      dunningExemptUntil: clients.dunningExemptUntil,
      isInternal: clients.isInternal,
      isDemo: clients.isDemo,
      businessName: organizations.name,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.id, match.clientId))
    .limit(1);
  if (!client) return "no_contact";

  const exempt = client.dunningExemptUntil !== null && client.dunningExemptUntil > now;
  if (exempt || client.isInternal || client.isDemo) {
    const claimed = await record(db, { ...match, dedupeKey, status: "suppressed" });
    return claimed ? "suppressed" : "already_sent";
  }
  if (!client.contactEmail) {
    const claimed = await record(db, { ...match, dedupeKey, status: "failed", error: "No contact email on file." });
    return claimed ? "no_contact" : "already_sent";
  }

  if (!(await record(db, { ...match, dedupeKey, status: "pending" }))) return "already_sent";

  const portal = (process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const message = buildPaymentReminderEmail({
    stage: "first_reminder",
    businessName: client.businessName,
    contactName: client.contactName,
    amountCents: invoice.amount_due ?? 0,
    reference: invoice.number ?? invoice.id ?? "",
    dueOn: invoice.created ? new Date(invoice.created * 1000) : now,
    daysOverdue: 0,
    portalUrl: `${portal}/dashboard`,
    cardDeclined: { payUrl: invoice.hosted_invoice_url ?? null },
  });
  const result = await sendEmail({ ...message, to: client.contactEmail });

  const claim = and(eq(notifications.dedupeKey, dedupeKey), eq(notifications.status, "pending"));
  if (result.status === "skipped") {
    await db.delete(notifications).where(claim);
    return "no_api_key";
  }
  if (result.status === "failed") {
    await db.update(notifications).set({ status: "failed", error: result.error }).where(claim);
    return "failed";
  }
  await db.update(notifications).set({ status: "sent", sentAt: now }).where(claim);
  return "sent";
}
