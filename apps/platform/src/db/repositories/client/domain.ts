import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, organizations, users } from "@/db/schema";
import { portalOrigin } from "@/lib/auth/reset";
import { apexDomain } from "@/lib/dns/records";
import { OTHER_REGISTRAR, REGISTRARS, registrarName } from "@/lib/domains/registrars";
import { buildDomainAccessEmail } from "@/lib/email/domain-access";
import { sendEmail } from "@/lib/email/mailer";
import { assertMutable, type TenantContext } from "../context";

/**
 * The client's domain step, after they have paid: they buy their domain
 * themselves, in their own name, give us access at the registrar, and tell
 * us here. Telling us emails every active operator and shows on the admin
 * onboarding card with the DNS records to add.
 *
 * "I've given you access" is the client's word, recorded as such. Nothing
 * here checks the registrar; the operator accepts the invitation there.
 */

export interface DomainStep {
  /** The address the client invites at the registrar. */
  accessEmail: string | null;
  domain: string | null;
  registrar: string | null;
  confirmedAt: Date | null;
  /** Whether they have paid for their website, which is when this step is due. */
  paid: boolean;
}

/**
 * Who the client invites. `DOMAIN_ACCESS_EMAIL` when set — the address the
 * operator's registrar accounts use — otherwise the operator's own login.
 */
export async function domainAccessEmail(db: Database): Promise<string | null> {
  const configured = process.env.DOMAIN_ACCESS_EMAIL?.trim();
  if (configured) return configured;
  const [operator] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return operator?.email ?? null;
}

export async function getDomainStep(db: Database, ctx: TenantContext): Promise<DomainStep | null> {
  const [row] = await db
    .select({
      domain: clients.domainName,
      registrar: clients.domainRegistrar,
      confirmedAt: clients.domainAccessConfirmedAt,
      buildPaidAt: clients.buildPaidAt,
      analyticsUnlockedAt: clients.analyticsUnlockedAt,
    })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  if (!row) return null;
  return {
    accessEmail: await domainAccessEmail(db),
    domain: row.domain,
    registrar: row.registrar,
    confirmedAt: row.confirmedAt,
    paid: Boolean(row.buildPaidAt ?? row.analyticsUnlockedAt),
  };
}

/** "Done, I've given you access": save the domain, and tell the operator. */
export async function confirmDomainAccess(
  db: Database,
  ctx: TenantContext,
  input: { domain: string; registrar: string },
): Promise<{ ok: boolean; message: string }> {
  assertMutable(ctx);
  const domain = apexDomain(input.domain);
  if (!domain) return { ok: false, message: "Type the domain you bought, like yourbusiness.com." };
  const known = input.registrar === OTHER_REGISTRAR || REGISTRARS.some((r) => r.key === input.registrar);
  if (!known) return { ok: false, message: "Choose where you bought it." };

  const [client] = await db
    .select({ id: clients.id, publicId: clients.publicId, businessName: organizations.name })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  if (!client) return { ok: false, message: "Your account is not linked to a client record." };

  const now = new Date();
  await db
    .update(clients)
    .set({ domainName: domain, domainRegistrar: input.registrar, domainAccessConfirmedAt: now, updatedAt: now })
    .where(eq(clients.id, client.id));

  const operators = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")));
  const message = buildDomainAccessEmail({
    businessName: client.businessName,
    domain,
    registrar: registrarName(input.registrar) ?? input.registrar,
    clientUrl: `${portalOrigin()}/admin/clients/${client.publicId}`,
  });
  let notified = 0;
  for (const operator of operators) {
    const sent = await sendEmail({ ...message, to: operator.email });
    if (sent.status === "sent") notified += 1;
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "domain.access_confirmed",
    entityType: "client",
    entityId: client.publicId,
    metadata: { domain, registrar: input.registrar, notified },
  });

  return { ok: true, message: `Thanks. We'll accept the invitation and point ${domain} at your new site.` };
}
