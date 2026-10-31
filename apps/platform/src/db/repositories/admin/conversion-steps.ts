import { and, eq, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  auditLog,
  clients,
  previewDeployments,
  prospectConversions,
  prospects,
  sites,
} from "@/db/schema";
import { provisionWebsite } from "@/lib/analytics/umami";
import { portalOrigin } from "@/lib/auth/reset";
import { sendEmail } from "@/lib/email/mailer";
import { buildWelcomeEmail } from "@/lib/email/welcome";
import { describesBusiness, isTemplateContent, siteDomain, type SiteJson } from "@/lib/site-json/read";
import { fillProfileGaps, profileFromSiteJson } from "@/lib/site-json/profile";
import { ActivationError, activateClient } from "./activation";
import { getBusinessProfile, saveBusinessProfile } from "./business-profile";
import { createClient, listOrganizationUsers, setClientSections } from "./clients";
import type { ConversionClient, ConversionProspect, ConversionSite, SiteJsonLoad } from "./conversion-state";
import { connectSiteToPortal } from "./conversion-snippet";
import { connectSiteForms } from "./leads";
import {
  describeTokenInstall,
  describeWorkflowInstall,
  installAgentWorkflow,
  installDeployWorkflow,
  installNetlifySiteVariable,
  installRepoTokens,
} from "./repo-tokens";
import { allowlistRepository } from "./scaffold";
import { setAnalyticsConnection } from "./sites";
import type { AdminContext } from "../context";

/**
 * The steps that make a potential client a connected client, in order.
 *
 * Each one either does its part or says precisely why it did not, and none of
 * them throws a provider's failure past the run: a Netlify outage at the leads
 * step must not stop the analytics step from being tried. The orchestrator in
 * `conversion.ts` decides which steps run; these only do the work.
 *
 * Every step reuses the function the matching admin button calls. Nothing here
 * re-implements a connection — if a step needs to behave differently from its
 * button, the difference belongs in the shared function.
 */

export const CONVERSION_STEPS = [
  "client",
  "site",
  "allowlist",
  "repo_secrets",
  "agent_workflow",
  "deploy_workflow",
  "netlify_site_variable",
  "leads_inbox",
  "analytics",
  "analytics_snippet",
  "business_profile",
  "site_kinds",
  "prospect_converted",
  "client_invite",
  "search_console",
  "google_calendar",
  "stripe_connect",
] as const;

export type ConversionStepId = (typeof CONVERSION_STEPS)[number];
export type StepStatus = "ok" | "failed" | "manual" | "skipped";

export interface StepOutcome {
  status: StepStatus;
  detail: string;
}

export interface ConvertOptions {
  /** Email the client their sign-in. Never implied: off unless asked for. */
  invite?: boolean;
  contactName?: string;
  contactEmail?: string;
  /** Explicit kinds win over what `site.json` declares. */
  booking?: boolean;
  shop?: boolean;
  /** Steps to repeat even though an earlier run finished them. */
  rerun?: ConversionStepId[];
  via: "operator-api" | "admin";
}

export interface RunState {
  ctx: AdminContext;
  db: Database;
  prospect: ConversionProspect;
  options: ConvertOptions;
  client: ConversionClient | null;
  site: ConversionSite | null;
  siteJson: () => Promise<SiteJsonLoad>;
}

/** With the client and site the orchestrator has confirmed exist. */
type Ready = RunState & { client: ConversionClient };
type ReadyWithSite = Ready & { site: ConversionSite };
type ReadyWithRepo = ReadyWithSite & { site: { repo: NonNullable<ConversionSite["repo"]> } };

export type Prerequisite = "client" | "site" | "repo";

const ok = (detail: string): StepOutcome => ({ status: "ok", detail });
const failed = (detail: string): StepOutcome => ({ status: "failed", detail });
const manual = (detail: string): StepOutcome => ({ status: "manual", detail });
const skipped = (detail: string): StepOutcome => ({ status: "skipped", detail });

/**
 * `site.json` when it may be believed about this business, or why not.
 *
 * Every step that copies something out of the file asks here, so the
 * template's demo business and a reference site's leftover details are
 * refused in one place rather than in each step.
 */
async function trustedSiteJson(
  state: RunState,
): Promise<{ ok: true; site: SiteJson } | { ok: false; outcome: StepOutcome }> {
  const json = await state.siteJson();
  if (!json.ok) {
    return {
      ok: false,
      outcome: json.reason === "invalid" ? failed(json.message) : skipped(json.message),
    };
  }
  if (isTemplateContent(json.site)) {
    return {
      ok: false,
      outcome: skipped("site.json still holds the template's demo business, so nothing was copied from it."),
    };
  }
  if (!describesBusiness(json.site, state.prospect.businessName)) {
    const named = json.site.meta?.businessName?.trim();
    return {
      ok: false,
      outcome: skipped(
        `site.json ${named ? `is about "${named}"` : "names no business"}, not ${state.prospect.businessName} — ` +
          "it may still be the site it was copied from. Correct meta.businessName and re-run.",
      ),
    };
  }
  return { ok: true, site: json.site };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

// ---------------------------------------------------------------------------
// The client and the site
// ---------------------------------------------------------------------------

async function stepClient(state: RunState): Promise<StepOutcome> {
  const { ctx, db, prospect, options, site } = state;
  if (state.client) return ok(`Already client ${state.client.clientPublicId}.`);

  let clientPublicId: string;
  try {
    ({ clientPublicId } = await createClient(ctx, db, {
      businessName: prospect.businessName,
      primaryContactName: options.contactName ?? prospect.contactName ?? undefined,
      primaryContactEmail: options.contactEmail ?? prospect.contactEmail ?? undefined,
      phone: prospect.contactPhone ?? undefined,
      industry: prospect.industry ?? undefined,
      bookingEnabled: options.booking ?? false,
      shopEnabled: options.shop ?? false,
      adoptOrganizationId: site?.organizationId,
    }));
  } catch (error) {
    // One client per organization is a unique index. Hitting it means a run
    // that started at the same moment created the client first; this one
    // links to it instead of failing.
    if (!site || !isUniqueViolation(error)) throw error;
    const [existing] = await db
      .select({ publicId: clients.publicId })
      .from(clients)
      .where(eq(clients.organizationId, site.organizationId))
      .limit(1);
    if (!existing) throw error;
    clientPublicId = existing.publicId;
  }

  const [client] = await db
    .select({ id: clients.id, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);

  await db
    .insert(prospectConversions)
    .values({
      prospectId: prospect.id,
      clientId: client!.id,
      organizationId: client!.organizationId,
      siteId: site?.siteId ?? null,
      // The concept's repository becomes the client's, kept under its name.
      repoStrategy: site ? "rename_transfer" : "fresh_repo",
      convertedBy: ctx.userId,
      notes: options.via === "operator-api" ? "Converted through the operator API." : "Converted from the admin.",
    })
    .onConflictDoNothing({ target: prospectConversions.prospectId });

  return ok(
    site
      ? `Created client ${clientPublicId} from the concept's organization.`
      : `Created client ${clientPublicId}. No concept site was built, so it has no website yet.`,
  );
}

async function stepSite(state: ReadyWithSite): Promise<StepOutcome> {
  const { db, site, client, prospect } = state;
  if (site.organizationId !== client.organizationId) {
    return failed("The concept site belongs to a different organization than the client. Nothing was moved.");
  }

  const now = new Date();
  // A draft is a concept nobody has agreed to. It is now the preview the client
  // sees at first sign-in, before paying to go live (D1).
  await db
    .update(sites)
    .set({ status: "preview", updatedAt: now })
    .where(and(eq(sites.id, site.siteId), eq(sites.status, "draft")));

  // Concepts expire so a mock-up nobody replied to does not sit on the internet
  // for ever. A client's site is not a mock-up.
  await db
    .update(previewDeployments)
    .set({ expiresAt: null })
    .where(and(eq(previewDeployments.siteId, site.siteId), eq(previewDeployments.kind, "concept")));

  await db
    .update(prospectConversions)
    .set({ siteId: site.siteId })
    .where(eq(prospectConversions.prospectId, prospect.id));

  const parts = [
    site.repo ? site.repo.repository : "no repository",
    site.netlifySiteName ? `Netlify site ${site.netlifySiteName}` : "no Netlify site",
  ];
  return ok(`Site ${site.sitePublicId} (${parts.join(", ")}) is now the client's; its preview no longer expires.`);
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

async function stepAllowlist({ db, ctx, site }: ReadyWithRepo): Promise<StepOutcome> {
  const changed = await allowlistRepository(db, ctx.userId, site.sitePublicId, true);
  return changed
    ? ok(`Automated work is allowed on ${site.repo.repository}.`)
    : failed("There is no connected repository to allow.");
}

async function stepRepoSecrets({ db, ctx, site }: ReadyWithRepo): Promise<StepOutcome> {
  const said = describeTokenInstall(await installRepoTokens(db, ctx.userId, site.sitePublicId));
  return said.ok ? ok(said.message) : failed(said.message);
}

async function stepAgentWorkflow({ db, ctx, site }: ReadyWithRepo): Promise<StepOutcome> {
  const said = describeWorkflowInstall(await installAgentWorkflow(db, ctx.userId, site.sitePublicId));
  return said.ok ? ok(said.message) : failed(said.message);
}

async function stepDeployWorkflow({ db, ctx, site }: ReadyWithRepo): Promise<StepOutcome> {
  const outcome = await installDeployWorkflow(db, ctx.userId, site.sitePublicId);
  if (!outcome.ok) return failed(`Could not install the deploy workflow (${outcome.reason}).`);
  const said = {
    installed: `Installed the deploy workflow in ${outcome.repository}.`,
    replaced: `Replaced ${outcome.repository}'s own deploy workflow with the shared one.`,
    current: `${outcome.repository} already deploys through the shared workflow.`,
  } as const;
  return ok(said[outcome.result]);
}

async function stepNetlifyVariable({ db, ctx, site }: ReadyWithRepo): Promise<StepOutcome> {
  const outcome = await installNetlifySiteVariable(db, ctx.userId, site.sitePublicId);
  if (outcome.ok) return ok(`NETLIFY_SITE_ID is ${outcome.netlifySiteId} in ${outcome.repository}.`);
  return failed(
    outcome.reason === "no_netlify_site"
      ? "The site has no Netlify site, so there is nothing to deploy to. Create one and record it on the client's page, then re-run."
      : `Could not set NETLIFY_SITE_ID (${outcome.reason}).`,
  );
}

// ---------------------------------------------------------------------------
// Leads and analytics
// ---------------------------------------------------------------------------

async function stepLeadsInbox({ db, ctx, site }: ReadyWithSite): Promise<StepOutcome> {
  if (site.formsConnectedAt) return ok("The site's forms already deliver to the leads inbox.");
  const outcome = await connectSiteForms(ctx, db, site.sitePublicId);
  return outcome.ok
    ? ok(`The site's forms now deliver to the leads inbox; ${outcome.imported} earlier submissions imported.`)
    : failed(outcome.message);
}

async function connectedWebsiteId(db: Database, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: analyticsConnections.umamiWebsiteId })
    .from(analyticsConnections)
    .where(eq(analyticsConnections.siteId, siteId))
    .limit(1);
  return row?.id ?? null;
}

async function stepAnalytics(state: ReadyWithSite): Promise<StepOutcome> {
  const { db, ctx, site, prospect } = state;
  const existing = await connectedWebsiteId(db, site.siteId);
  if (existing) return ok(`Umami website ${existing} is already connected.`);

  // The real domain when anyone knows it, so go-live finds this same website
  // rather than making a second; otherwise the Netlify address, which
  // go-live then keeps (see `verifyAndGoLive`).
  const json = await trustedSiteJson(state);
  const domain =
    site.primaryDomain ??
    (json.ok ? siteDomain(json.site) : null) ??
    (site.netlifySiteName ? `${site.netlifySiteName}.netlify.app` : null);
  if (!domain) return failed("No domain or Netlify site to name the Umami website after.");

  const provisioned = await provisionWebsite({ name: prospect.businessName, domain });
  if (!provisioned.ok) {
    return failed(
      provisioned.reason === "not_configured"
        ? "Umami is not configured here: set UMAMI_API_BASE_URL and UMAMI_API_KEY."
        : provisioned.message,
    );
  }

  const connected = await setAnalyticsConnection(ctx, db, site.sitePublicId, provisioned.websiteId);
  if (!connected.ok) return failed(`Umami answered, but the connection was not saved (${connected.reason}).`);

  return ok(
    `${provisioned.created ? "Created" : "Found"} Umami website ${provisioned.websiteId} for ${domain}.`,
  );
}

async function stepAnalyticsSnippet(state: ReadyWithRepo): Promise<StepOutcome> {
  const websiteId = await connectedWebsiteId(state.db, state.site.siteId);
  if (!websiteId) return skipped("There is no Umami website yet; the analytics step comes first.");
  return connectSiteToPortal(state.site, websiteId, await state.siteJson(), state.prospect.businessName);
}

// ---------------------------------------------------------------------------
// What the site says about the business
// ---------------------------------------------------------------------------

async function stepBusinessProfile(state: ReadyWithSite): Promise<StepOutcome> {
  const { ctx, db, client } = state;
  const json = await trustedSiteJson(state);
  if (!json.ok) {
    return json.outcome.status === "skipped"
      ? skipped(`${json.outcome.detail} Fill General information on the client's page instead.`)
      : json.outcome;
  }

  const fromSite = profileFromSiteJson(json.site);
  const existing = (await getBusinessProfile(db, client.organizationId))?.details ?? {};
  const gaps = fillProfileGaps(existing, fromSite.details);

  const notes = [
    gaps.kept.length > 0 ? `Kept what was already entered for ${gaps.kept.join(", ")}.` : null,
    fromSite.rejected.length > 0
      ? `Left out placeholder or invalid values for ${fromSite.rejected.join(", ")}.`
      : null,
  ].filter(Boolean);

  if (gaps.filled.length === 0) {
    return ok(["Nothing new to add from site.json.", ...notes].join(" "));
  }

  await saveBusinessProfile(ctx, db, client.organizationId, gaps.details);
  return ok([`Filled ${gaps.filled.join(", ")} from site.json.`, ...notes].join(" "));
}

async function stepSiteKinds(state: Ready): Promise<StepOutcome> {
  const { ctx, db, client, options } = state;
  const json = state.site ? await trustedSiteJson(state) : null;
  const declared = json?.ok ? json.site : null;

  const booking = options.booking ?? declared?.booking?.enabled;
  const shop = options.shop ?? declared?.shop?.enabled;
  if (booking === undefined && shop === undefined) {
    return skipped("Neither the request nor site.json says whether they take bookings or sell online.");
  }

  await setClientSections(ctx, db, client.clientPublicId, {
    bookingEnabled: booking ?? client.bookingEnabled,
    shopEnabled: shop ?? client.shopEnabled,
  });

  const source = (explicit: boolean | undefined) => (explicit === undefined ? "site.json" : "the request");
  return ok(
    `Booking ${booking ?? client.bookingEnabled ? "on" : "off"} (${source(options.booking)}), ` +
      `shop ${shop ?? client.shopEnabled ? "on" : "off"} (${source(options.shop)}).`,
  );
}

// ---------------------------------------------------------------------------
// Closing the prospect, and the client's sign-in
// ---------------------------------------------------------------------------

async function stepProspectConverted({ db, ctx, prospect, client, options }: Ready): Promise<StepOutcome> {
  const updated = await db
    .update(prospects)
    .set({ status: "converted", updatedAt: new Date() })
    .where(and(eq(prospects.id, prospect.id), ne(prospects.status, "converted")))
    .returning({ id: prospects.id });

  if (updated.length > 0) {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      organizationId: client.organizationId,
      action: "prospect.converted",
      entityType: "prospect",
      entityId: prospect.publicId,
      metadata: { clientPublicId: client.clientPublicId, via: options.via },
    });
  }
  return ok("Off the Potential clients list; listed with the clients.");
}

/**
 * The welcome email, only when asked for.
 *
 * The temporary password `activateClient` returns goes into the email and
 * nowhere else: not into the report, not into the audit row, not into the
 * log. If the email does not go, the password is lost with it — which is the
 * right failure, because the remedy (reissue) exists and a password in an API
 * response would sit in an agent's transcript for ever.
 */
async function stepClientInvite(state: Ready): Promise<StepOutcome> {
  const { ctx, db, client, prospect, options } = state;
  if (!options.invite) {
    return skipped("Not requested. Send invite: true, or use Activate on the client's page, to email them their sign-in.");
  }

  const members = await listOrganizationUsers(ctx, db, client.organizationId);
  if (members[0]) {
    return ok(
      `They already have a portal sign-in (${members[0].email}). If the welcome email never arrived, use Reissue on the client's page.`,
    );
  }

  const email = options.contactEmail ?? client.primaryContactEmail ?? prospect.contactEmail;
  if (!email) return failed("There is no email address for the client. Re-run with contactEmail.");
  const contactName = options.contactName ?? client.primaryContactName ?? prospect.contactName ?? "";

  let issued;
  try {
    issued = await activateClient(ctx, db, {
      organizationId: client.organizationId,
      contactName,
      contactEmail: email,
    });
  } catch (error) {
    if (error instanceof ActivationError) return failed(error.message);
    throw error;
  }

  const message = buildWelcomeEmail({
    businessName: prospect.businessName,
    contactName: contactName || null,
    username: issued.username,
    temporaryPassword: issued.temporaryPassword,
    portalUrl: portalOrigin(),
    expiresAt: issued.expiresAt,
  });
  const sent = await sendEmail({ ...message, to: issued.email });

  if (sent.status !== "sent") {
    const why = sent.status === "skipped" ? "no RESEND_API_KEY here" : sent.error;
    return failed(
      `Their sign-in was created but the welcome email was not sent (${why}). Use Reissue on the client's page to send a fresh temporary password.`,
    );
  }
  return ok(`Welcome email sent to ${issued.email}; their sign-in handle is ${issued.username}.`);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

type StepFn = (state: never) => Promise<StepOutcome>;

export const STEP_DEFINITIONS: Record<ConversionStepId, { needs: Prerequisite[]; run: StepFn }> = {
  client: { needs: [], run: stepClient },
  site: { needs: ["client", "site"], run: stepSite },
  allowlist: { needs: ["client", "site", "repo"], run: stepAllowlist },
  repo_secrets: { needs: ["client", "site", "repo"], run: stepRepoSecrets },
  agent_workflow: { needs: ["client", "site", "repo"], run: stepAgentWorkflow },
  deploy_workflow: { needs: ["client", "site", "repo"], run: stepDeployWorkflow },
  netlify_site_variable: { needs: ["client", "site", "repo"], run: stepNetlifyVariable },
  leads_inbox: { needs: ["client", "site"], run: stepLeadsInbox },
  analytics: { needs: ["client", "site"], run: stepAnalytics },
  analytics_snippet: { needs: ["client", "site", "repo"], run: stepAnalyticsSnippet },
  business_profile: { needs: ["client", "site"], run: stepBusinessProfile },
  site_kinds: { needs: ["client"], run: stepSiteKinds },
  prospect_converted: { needs: ["client"], run: stepProspectConverted },
  client_invite: { needs: ["client"], run: stepClientInvite },
  // Each needs the client's own Google or Stripe account. The portal cannot
  // grant consent for them, so these say where the client does it.
  search_console: {
    needs: ["client"],
    run: async () =>
      manual("The client connects Google Search Console from their portal; it needs their Google account."),
  },
  google_calendar: {
    needs: ["client"],
    run: async ({ client }: Ready) =>
      client.bookingEnabled
        ? manual("The client connects Google Calendar from Availability, so their busy times block bookings.")
        : skipped("Booking is off."),
  },
  stripe_connect: {
    needs: ["client"],
    run: async ({ client }: Ready) =>
      client.shopEnabled
        ? manual("The client connects Stripe from their shop page before anything can be sold.")
        : skipped("The shop is off."),
  },
};
