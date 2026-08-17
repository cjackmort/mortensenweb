import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  auditLog,
  clients,
  notifications,
  organizations,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { apexDomain, buildDnsRecords } from "@/lib/dns/records";
import {
  buildDnsInstructionsEmail,
  buildSiteLiveEmail,
} from "@/lib/email/dns-instructions";
import { sendEmail } from "@/lib/email/mailer";
import { provisionWebsite } from "@/lib/analytics/umami";
import { verifyUrlServes } from "@/lib/netlify/api";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Going live.
 *
 * Three separate operator actions, deliberately not one button, because they
 * happen days apart and the middle one is out of our hands:
 *
 *   1. `sendDnsInstructions` — tell the client what to change
 *   2. …the client changes it, or asks us to do it with them…
 *   3. `verifyAndGoLive`     — check it actually resolves, then flip everything
 *
 * A single "launch" button would have to either block on DNS propagation, which
 * can take 48 hours, or declare success before it happened. The second is what
 * most systems do, and it is why clients get "your site is live!" emails
 * pointing at pages that do not load.
 */

// ---------------------------------------------------------------------------
// Step 1 — instructions
// ---------------------------------------------------------------------------

export type DnsSendOutcome =
  | { ok: true; sent: boolean; domain: string; recordCount: number }
  | {
      ok: false;
      reason: "not_found" | "no_domain" | "no_netlify" | "no_contact";
      message: string;
    };

export async function sendDnsInstructions(
  ctx: AdminContext,
  db: Database,
  sitePublicId: string,
): Promise<DnsSendOutcome> {
  const rows = await db
    .select({
      id: sites.id,
      name: sites.name,
      organizationId: sites.organizationId,
      primaryDomain: sites.primaryDomain,
      netlifySiteName: sites.netlifySiteName,
      contactName: clients.primaryContactName,
      contactEmail: clients.primaryContactEmail,
      businessName: organizations.name,
    })
    .from(sites)
    .leftJoin(clients, eq(clients.organizationId, sites.organizationId))
    .leftJoin(organizations, eq(organizations.id, sites.organizationId))
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const site = rows[0];
  if (!site) throw new NotFoundError();

  const domain = site.primaryDomain ? apexDomain(site.primaryDomain) : null;
  if (!domain) {
    return {
      ok: false,
      reason: "no_domain",
      message: "Record the client's domain against this site first.",
    };
  }
  if (!site.netlifySiteName) {
    return {
      ok: false,
      reason: "no_netlify",
      message: "This site has no Netlify site, so there is nothing to point at.",
    };
  }
  if (!site.contactEmail) {
    return {
      ok: false,
      reason: "no_contact",
      message: "This client has no contact email address on file.",
    };
  }

  const records = buildDnsRecords(domain, site.netlifySiteName);

  const message = buildDnsInstructionsEmail({
    businessName: site.businessName ?? site.name,
    contactName: site.contactName,
    domain,
    records,
    portalUrl: process.env.AUTH_URL ?? "",
  });

  const result = await sendEmail({ ...message, to: site.contactEmail });

  const now = new Date();

  // The records are stored as sent, not regenerated on demand. Months later,
  // when something breaks and they call, "what did we actually tell them to
  // do?" needs one answer — and the recommended record for their setup may
  // have changed since.
  await db
    .update(sites)
    .set({
      dnsRecords: records,
      // Only stamped on an actual send. In development the mailer logs instead
      // of sending, and recording that as sent would leave a client waiting for
      // an email that was never going to arrive.
      dnsInstructionsSentAt: result.status === "sent" ? now : null,
      updatedAt: now,
    })
    .where(eq(sites.id, site.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: site.organizationId,
    action: "site.dns_instructions_sent",
    entityType: "site",
    entityId: sitePublicId,
    metadata: { domain, deliveryStatus: result.status },
  });

  return {
    ok: true,
    sent: result.status === "sent",
    domain,
    recordCount: records.length,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — verify and flip
// ---------------------------------------------------------------------------

export type GoLiveOutcome =
  | {
      ok: true;
      domain: string;
      analyticsWebsiteId: string | null;
      analyticsNote?: string;
      emailSent: boolean;
    }
  | {
      ok: false;
      reason: "not_found" | "no_domain" | "not_resolving";
      message: string;
    };

/**
 * Confirm the domain resolves, then make everything else true.
 *
 * The verification is the gate, and it is a real fetch against the client's
 * actual domain. Everything after it — site status, Umami, the client's tag,
 * the announcement email — is downstream of one observed fact: the site
 * answers. Nothing here trusts a deploy status or a DNS API.
 *
 * Analytics failing does not fail the launch. The site is live; that is the
 * thing the client cares about, and a missing analytics connection is a
 * five-second fix on the operator's side rather than a reason to leave the
 * launch half-applied.
 */
export async function verifyAndGoLive(
  ctx: AdminContext,
  db: Database,
  sitePublicId: string,
): Promise<GoLiveOutcome> {
  const rows = await db
    .select({
      id: sites.id,
      name: sites.name,
      organizationId: sites.organizationId,
      primaryDomain: sites.primaryDomain,
      clientId: clients.id,
      clientPublicId: clients.publicId,
      contactName: clients.primaryContactName,
      contactEmail: clients.primaryContactEmail,
      businessName: organizations.name,
    })
    .from(sites)
    .leftJoin(clients, eq(clients.organizationId, sites.organizationId))
    .leftJoin(organizations, eq(organizations.id, sites.organizationId))
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);

  const site = rows[0];
  if (!site) throw new NotFoundError();

  const domain = site.primaryDomain ? apexDomain(site.primaryDomain) : null;
  if (!domain) {
    return {
      ok: false,
      reason: "no_domain",
      message: "Record the client's domain against this site first.",
    };
  }

  const productionUrl = `https://${domain}`;
  const check = await verifyUrlServes(productionUrl, { timeoutMs: 15_000 });

  if (!check.ok) {
    return {
      ok: false,
      reason: "not_resolving",
      message:
        check.reason === "unreachable"
          ? `${domain} isn't resolving yet. DNS can take up to 48 hours — try again later.`
          : `${domain} answered ${check.status ?? "an error"}. Check the records before going live.`,
    };
  }

  const now = new Date();

  // Analytics next, because the tracking script has to be in place before the
  // site is announced or the first day's traffic is lost.
  let analyticsWebsiteId: string | null = null;
  let analyticsNote: string | undefined;

  const provisioned = await provisionWebsite({
    name: site.businessName ?? site.name,
    domain,
  });

  if (provisioned.ok) {
    analyticsWebsiteId = provisioned.websiteId;

    const existing = await db
      .select({ id: analyticsConnections.id })
      .from(analyticsConnections)
      .where(eq(analyticsConnections.siteId, site.id))
      .limit(1);

    const values = {
      provider: "umami",
      umamiWebsiteId: provisioned.websiteId,
      status: "connected",
      lastSyncedAt: null,
    };

    if (existing[0]) {
      await db
        .update(analyticsConnections)
        .set(values)
        .where(eq(analyticsConnections.id, existing[0].id));
    } else {
      await db.insert(analyticsConnections).values({ siteId: site.id, ...values });
    }
  } else {
    analyticsNote =
      provisioned.reason === "not_configured"
        ? "Umami is not configured, so no analytics website was created."
        : `Analytics setup failed: ${provisioned.message}. The site is live regardless.`;
  }

  await db
    .update(sites)
    .set({
      status: "live",
      productionUrl,
      liveVerifiedAt: now,
      launchApprovedAt: now,
      launchApprovedBy: ctx.userId,
      updatedAt: now,
    })
    .where(eq(sites.id, site.id));

  if (site.clientId) {
    await db
      .update(clients)
      .set({ onboardingStatus: "active", updatedAt: now })
      .where(eq(clients.id, site.clientId));
  }

  let emailSent = false;
  if (site.contactEmail) {
    const message = buildSiteLiveEmail({
      businessName: site.businessName ?? site.name,
      contactName: site.contactName,
      domain,
      portalUrl: process.env.AUTH_URL ?? "",
    });
    const result = await sendEmail({ ...message, to: site.contactEmail });
    emailSent = result.status === "sent";

    await db.insert(notifications).values({
      publicId: newPublicId(),
      organizationId: site.organizationId,
      kind: "site_live",
      subjectType: "site",
      subjectId: site.id,
      channel: "email",
      status: emailSent ? "sent" : "failed",
      // Keyed on the site, so re-running a launch cannot send a second
      // "your site is live" email to someone whose site already was.
      dedupeKey: `site_live:${sitePublicId}`,
      sentAt: emailSent ? now : null,
    });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: site.organizationId,
    action: "site.went_live",
    entityType: "site",
    entityId: sitePublicId,
    metadata: {
      domain,
      productionUrl,
      analyticsWebsiteId,
      verifiedStatus: check.status,
    },
  });

  return { ok: true, domain, analyticsWebsiteId, analyticsNote, emailSent };
}

/**
 * Re-check that live sites are still serving.
 *
 * Runs on the schedule. Certificates lapse, domains expire, and a client's
 * registrar can undo a record while "tidying up" — and in every one of those
 * cases the operator should hear it from this rather than from the client.
 */
export async function reverifyLiveSites(db: Database): Promise<
  { sitePublicId: string; domain: string; problem: string }[]
> {
  const live = await db
    .select({
      publicId: sites.publicId,
      productionUrl: sites.productionUrl,
      primaryDomain: sites.primaryDomain,
      id: sites.id,
    })
    .from(sites)
    .where(eq(sites.status, "live"))
    .limit(100);

  const problems: { sitePublicId: string; domain: string; problem: string }[] = [];

  for (const site of live) {
    if (!site.productionUrl) continue;
    const check = await verifyUrlServes(site.productionUrl, { timeoutMs: 10_000 });

    if (check.ok) {
      await db
        .update(sites)
        .set({ liveVerifiedAt: new Date() })
        .where(eq(sites.id, site.id));
      continue;
    }

    problems.push({
      sitePublicId: site.publicId,
      domain: site.primaryDomain ?? site.productionUrl,
      problem:
        check.reason === "unreachable"
          ? "not reachable"
          : `responded ${check.status ?? check.reason}`,
    });
  }

  return problems;
}
