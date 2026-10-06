import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  leads,
  organizationMemberships,
  organizations,
  users,
} from "@/db/schema";
import { buildLeadReceivedEmail } from "@/lib/email/lead-received";
import { sendEmail } from "@/lib/email/mailer";

/**
 * Email the client about a lead that just arrived.
 *
 * A separate step after the lead is stored, never part of storing it: a mail
 * outage must not lose an enquiry, and the inbox is the record either way.
 *
 * ## Exactly once
 *
 * `notified_at` is claimed before sending, in one conditional update, so two
 * deliveries of the same submission racing each other cannot both send. A
 * send that fails releases the claim, so the column only ever says "emailed"
 * about a lead that was.
 *
 * Recipients are the organization's active client users, falling back to the
 * primary contact — the same rule as request updates.
 */

export type LeadNotifyOutcome =
  | { status: "sent"; to: number }
  | { status: "skipped"; reason: "already_sent" | "no_recipient" | "no_api_key" }
  | { status: "failed"; error: string };

export async function notifyClientOfLead(
  db: Database,
  leadId: string,
): Promise<LeadNotifyOutcome> {
  const claimed = await db
    .update(leads)
    .set({ notifiedAt: new Date() })
    .where(and(eq(leads.id, leadId), isNull(leads.notifiedAt), isNull(leads.deletedAt)))
    .returning({
      publicId: leads.publicId,
      organizationId: leads.organizationId,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      message: leads.message,
    });
  const lead = claimed[0];
  if (!lead) return { status: "skipped", reason: "already_sent" };

  const release = () =>
    db.update(leads).set({ notifiedAt: null }).where(eq(leads.id, leadId));

  try {
    const orgRows = await db
      .select({
        businessName: organizations.name,
        contactName: clients.primaryContactName,
        contactEmail: clients.primaryContactEmail,
      })
      .from(organizations)
      .leftJoin(clients, eq(clients.organizationId, organizations.id))
      .where(eq(organizations.id, lead.organizationId))
      .limit(1);
    const org = orgRows[0];

    const members = await db
      .select({ email: users.email, name: users.name })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(
        and(
          eq(organizationMemberships.organizationId, lead.organizationId),
          eq(users.role, "client"),
          eq(users.status, "active"),
        ),
      );

    const recipients = members.length
      ? members
      : org?.contactEmail
        ? [{ email: org.contactEmail, name: org.contactName }]
        : [];

    if (recipients.length === 0) {
      await release();
      return { status: "skipped", reason: "no_recipient" };
    }

    const portalUrl = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
    let sent = 0;
    let skipped = false;
    let lastError: string | null = null;

    for (const recipient of recipients) {
      const message = buildLeadReceivedEmail({
        contactName: recipient.name ?? org?.contactName ?? null,
        businessName: org?.businessName ?? "your business",
        lead,
        portalUrl,
      });
      const result = await sendEmail({ ...message, to: recipient.email });
      if (result.status === "sent") sent += 1;
      else if (result.status === "skipped") skipped = true;
      else lastError = result.error;
    }

    if (sent > 0) return { status: "sent", to: sent };
    await release();
    if (skipped) return { status: "skipped", reason: "no_api_key" };
    return { status: "failed", error: lastError ?? "Unknown error" };
  } catch (error) {
    await release();
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
