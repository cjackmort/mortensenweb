import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, organizationMemberships, organizations, payments, sites, users } from "@/db/schema";
import { buildDnsRecords, type DnsRecord } from "@/lib/dns/records";
import { REGISTRARS, registrarName } from "@/lib/domains/registrars";
import { domainAccessEmail } from "../client/domain";
import { buildDemoInviteEmail, demoInviteDraft } from "@/lib/email/demo-invite";
import { sendEmail } from "@/lib/email/mailer";
import { onboardingSteps, type OnboardingStep, type OnboardingStepKey } from "@/lib/onboarding/status";
import type { AdminContext } from "../context";

/**
 * A new client from the operator's side, before they pay: the demo URL, the
 * email that sends it and asks for a call, and how far they have got.
 *
 * The demo email goes through the same mailer as every other email, and is
 * stamped as sent only when it was: a skipped send (no API key here) or a
 * failed one leaves the step undone, so the status never claims an email a
 * prospect did not get. What was sent, to whom, and the outcome are in the
 * audit log.
 */

export interface OnboardingView {
  demoUrl: string | null;
  demoSentAt: Date | null;
  steps: OnboardingStep[];
  next: OnboardingStepKey | null;
  /** The demo email as the operator will first see it, ready to edit. */
  draft: { to: string; subject: string; body: string };
  /** The domain the client bought, once they have told us; null before. */
  domain: OnboardingDomain | null;
  /** The address clients are told to invite at their registrar. */
  accessEmail: string | null;
}

export interface OnboardingDomain {
  name: string;
  registrar: string | null;
  accessConfirmedAt: Date | null;
  /** The site's Netlify name, which the www CNAME points at; null until connected. */
  netlifySiteName: string | null;
  /** What to add at the registrar: the same records the launch email sends. Empty without a Netlify name. */
  records: DnsRecord[];
  /** Anything specific to adding records at this registrar. */
  operatorNote: string | null;
}

function earliest(dates: Array<Date | null>): Date | null {
  return dates.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export async function getOnboarding(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<OnboardingView | null> {
  const [client] = await db
    .select({
      id: clients.id,
      organizationId: clients.organizationId,
      businessName: organizations.name,
      contactName: clients.primaryContactName,
      contactEmail: clients.primaryContactEmail,
      demoUrl: clients.demoUrl,
      demoSentAt: clients.demoSentAt,
      buildPaidAt: clients.buildPaidAt,
      domainName: clients.domainName,
      domainRegistrar: clients.domainRegistrar,
      domainAccessConfirmedAt: clients.domainAccessConfirmedAt,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!client) return null;

  const [accounts, firstPayment, sender, site, accessEmail] = await Promise.all([
    db
      .select({
        email: users.email,
        invitedAt: users.invitedAt,
        activatedAt: users.activatedAt,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .innerJoin(organizationMemberships, eq(organizationMemberships.userId, users.id))
      .where(eq(organizationMemberships.organizationId, client.organizationId)),
    db
      .select({ receivedOn: payments.receivedOn })
      .from(payments)
      .where(and(eq(payments.clientId, client.id), eq(payments.status, "recorded"), gt(payments.amountCents, 0)))
      .orderBy(asc(payments.receivedOn))
      .limit(1),
    db.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1),
    db
      .select({ netlifySiteName: sites.netlifySiteName })
      .from(sites)
      .where(and(eq(sites.organizationId, client.organizationId), isNotNull(sites.netlifySiteName)))
      .orderBy(asc(sites.createdAt))
      .limit(1),
    domainAccessEmail(db),
  ]);

  const paidOn = firstPayment[0]?.receivedOn;
  const { steps, next } = onboardingSteps({
    demoSentAt: client.demoSentAt,
    loginSentAt: earliest(accounts.map((a) => a.invitedAt)),
    passwordSetAt: earliest(accounts.filter((a) => !a.mustChangePassword).map((a) => a.activatedAt)),
    paidAt: client.buildPaidAt ?? (paidOn ? new Date(`${paidOn}T12:00:00Z`) : null),
    domainAccessAt: client.domainAccessConfirmedAt,
  });

  const netlifySiteName = site[0]?.netlifySiteName ?? null;
  const domain: OnboardingDomain | null = client.domainName
    ? {
        name: client.domainName,
        registrar: registrarName(client.domainRegistrar),
        accessConfirmedAt: client.domainAccessConfirmedAt,
        netlifySiteName,
        records: netlifySiteName ? buildDnsRecords(client.domainName, netlifySiteName) : [],
        operatorNote: REGISTRARS.find((r) => r.key === client.domainRegistrar)?.operatorNote ?? null,
      }
    : null;

  const draft = demoInviteDraft({
    businessName: client.businessName,
    contactName: client.contactName,
    demoUrl: client.demoUrl ?? "",
    senderName: sender[0]?.name ?? null,
  });

  return {
    demoUrl: client.demoUrl,
    demoSentAt: client.demoSentAt,
    steps,
    next,
    draft: { to: client.contactEmail ?? accounts[0]?.email ?? "", ...draft },
    domain,
    accessEmail,
  };
}

type Result = { ok: boolean; message: string };

async function clientRow(db: Database, clientPublicId: string) {
  const [row] = await db
    .select({ id: clients.id, organizationId: clients.organizationId, demoUrl: clients.demoUrl })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  return row ?? null;
}

/** Save the demo's address. Only `https:` — it goes into an email a prospect taps. */
export async function setDemoUrl(
  ctx: AdminContext,
  db: Database,
  input: { clientPublicId: string; demoUrl: string },
): Promise<Result> {
  const raw = input.demoUrl.trim();
  let demoUrl: string | null = null;
  if (raw) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, message: "That isn't a web address. Paste the whole link, starting https://" };
    }
    if (parsed.protocol !== "https:") return { ok: false, message: "Use the https:// link to the demo." };
    demoUrl = parsed.href;
  }

  const client = await clientRow(db, input.clientPublicId);
  if (!client) return { ok: false, message: "No such client." };
  await db.update(clients).set({ demoUrl, updatedAt: new Date() }).where(eq(clients.id, client.id));
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "onboarding.demo_url_set",
    entityType: "client",
    entityId: input.clientPublicId,
    metadata: { demoUrl },
  });
  return { ok: true, message: demoUrl ? "Saved." : "Cleared." };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;

/** Send the demo email as the operator edited it. */
export async function sendDemoInvite(
  ctx: AdminContext,
  db: Database,
  input: { clientPublicId: string; to: string; subject: string; body: string },
): Promise<Result> {
  const to = input.to.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!EMAIL.test(to)) return { ok: false, message: "Enter the email address to send it to." };
  if (!subject || subject.length > MAX_SUBJECT) return { ok: false, message: "Write a subject line." };
  if (!body || body.length > MAX_BODY) return { ok: false, message: "Write the message." };

  const client = await clientRow(db, input.clientPublicId);
  if (!client) return { ok: false, message: "No such client." };
  if (!client.demoUrl) return { ok: false, message: "Save the demo URL first." };

  const sent = await sendEmail({ ...buildDemoInviteEmail({ subject, body, demoUrl: client.demoUrl }), to });
  if (sent.status === "sent") {
    await db.update(clients).set({ demoSentAt: new Date(), updatedAt: new Date() }).where(eq(clients.id, client.id));
  }
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "onboarding.demo_sent",
    entityType: "client",
    entityId: input.clientPublicId,
    metadata: { to, subject, demoUrl: client.demoUrl, status: sent.status },
  });

  if (sent.status === "sent") return { ok: true, message: `Sent to ${to}.` };
  if (sent.status === "skipped") {
    return { ok: false, message: "Not sent: email isn't set up here, so it was written to the server log instead." };
  }
  return { ok: false, message: "Not sent: the email service refused it. Try again in a minute." };
}
