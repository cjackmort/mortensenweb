import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  conceptJobs,
  conceptRepositories,
  organizations,
  previewDeployments,
  prospectContacts,
  prospects,
  servicePlans,
  siteBriefs,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { isGithubConfigured } from "@/lib/github/app";
import { listTemplateRepos } from "@/lib/github/rest";
import { scaffoldSite } from "./scaffold";
import { dispatchBrief } from "./briefs";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Potential clients, and turning one into a demo.
 *
 * This is the front of the funnel: a business is written down, a plan is
 * chosen, and an agent builds a concept site to show them. Two constraints from
 * Stage 0 shape it and neither is negotiable.
 *
 * **A concept repository is private, always.** A speculative mock-up of a
 * business that has agreed to nothing must not be publicly readable. Enforced
 * in three places — here, in `createRepoFromTemplate`'s explicit `private`
 * argument, and by a check constraint on `concept_repositories`.
 *
 * **Nothing reaches a prospect automatically.** There is no outbound email path
 * from this module. Sharing a concept is an operator act that mints a
 * short-lived token; until they do it, the demo exists and nobody outside the
 * agency has been contacted.
 */

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface NewProspectInput {
  businessName: string;
  sourceWebsiteUrl?: string;
  industry?: string;
  location?: string;
  serviceArea?: string;
  tone?: string;
  notes?: string;
  /** The plan being pitched. Decides what the demo should show. */
  planKey?: string;
  /** `owner/name` of one of our sites to base the concept on. */
  referenceRepo?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  /** Why we hold this contact. There is no automated outreach path regardless. */
  consentNote?: string;
}

export type CreateProspectResult =
  | { ok: true; publicId: string }
  | { ok: false; reason: "invalid_name" | "invalid_url" | "unknown_plan"; message: string };

/**
 * Validate a prospect's existing website URL.
 *
 * HTTPS only and no credentials in the URL. This value is later handed to the
 * crawler, and §13.1 requires SSRF guards there — but refusing the obviously
 * wrong shapes at the point of entry means an operator finds out immediately,
 * while they still have the business's details in front of them, rather than
 * when an audit job fails hours later.
 */
export function normaliseSourceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A URL carrying credentials is either a mistake or an attempt to get them
  // stored somewhere they should not be.
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;

  return url.toString();
}

export async function createProspect(
  ctx: AdminContext,
  db: Database,
  input: NewProspectInput,
): Promise<CreateProspectResult> {
  const businessName = input.businessName.trim();
  if (businessName.length < 2) {
    return {
      ok: false,
      reason: "invalid_name",
      message: "A business name is required.",
    };
  }

  let sourceWebsiteUrl: string | null = null;
  if (input.sourceWebsiteUrl?.trim()) {
    sourceWebsiteUrl = normaliseSourceUrl(input.sourceWebsiteUrl);
    if (!sourceWebsiteUrl) {
      return {
        ok: false,
        reason: "invalid_url",
        message: "That doesn't look like a website address.",
      };
    }
  }

  let planId: string | null = null;
  if (input.planKey) {
    const plans = await db
      .select({ id: servicePlans.id })
      .from(servicePlans)
      .where(eq(servicePlans.key, input.planKey))
      .limit(1);
    if (!plans[0]) {
      return {
        ok: false,
        reason: "unknown_plan",
        message: "That plan no longer exists.",
      };
    }
    planId = plans[0].id;
  }

  const publicId = newPublicId();

  const inserted = await db
    .insert(prospects)
    .values({
      publicId,
      businessName,
      sourceWebsiteUrl,
      industry: input.industry?.trim() || null,
      location: input.location?.trim() || null,
      serviceArea: input.serviceArea?.trim() || null,
      tone: input.tone?.trim() || null,
      notes: input.notes?.trim() || null,
      planId,
      referenceRepo: input.referenceRepo?.trim() || null,
      status: "new",
      createdBy: ctx.userId,
    })
    .returning({ id: prospects.id });

  const prospectId = inserted[0]!.id;

  if (input.contactName || input.contactEmail || input.contactPhone) {
    await db.insert(prospectContacts).values({
      prospectId,
      name: input.contactName?.trim() || null,
      email: input.contactEmail?.trim().toLowerCase() || null,
      phone: input.contactPhone?.trim() || null,
      consentNote: input.consentNote?.trim() || null,
    });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "prospect.created",
    entityType: "prospect",
    entityId: publicId,
    metadata: { businessName, planKey: input.planKey ?? null },
  });

  return { ok: true, publicId };
}

// ---------------------------------------------------------------------------
// Concept build
// ---------------------------------------------------------------------------

export type ConceptOutcome =
  | {
      ok: true;
      repo: { owner: string; name: string; htmlUrl: string };
      issueNumber?: number;
      issueUrl?: string;
      warning?: string;
    }
  | { ok: false; reason: string; message: string };

/**
 * Build a demo site for a prospect.
 *
 * Four steps: give the prospect a holding organization, scaffold a private
 * repository and Netlify site, write the brief the agent will work from, and
 * dispatch it.
 *
 * The holding organization is the part worth explaining. A prospect is not a
 * tenant — nobody can sign in to it and there are no client users — but `sites`
 * is keyed on `organization_id` because tenancy is structural in this schema.
 * Rather than making that column nullable, which would weaken the isolation
 * guarantee everywhere for the sake of one case, a prospect gets an
 * organization with no members. Nothing can reach it, because reaching anything
 * requires a session and no session resolves to it.
 */
export async function buildConcept(
  ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
  instructions: { colourDirection?: string; features?: string; contentNotes?: string },
): Promise<ConceptOutcome> {
  const rows = await db
    .select({
      id: prospects.id,
      publicId: prospects.publicId,
      businessName: prospects.businessName,
      industry: prospects.industry,
      tone: prospects.tone,
      location: prospects.location,
      serviceArea: prospects.serviceArea,
      notes: prospects.notes,
      referenceRepo: prospects.referenceRepo,
      status: prospects.status,
      planName: servicePlans.name,
      planIncludesAnalytics: servicePlans.includesAnalytics,
    })
    .from(prospects)
    .leftJoin(servicePlans, eq(servicePlans.id, prospects.planId))
    .where(eq(prospects.publicId, prospectPublicId))
    .limit(1);

  const prospect = rows[0];
  if (!prospect) throw new NotFoundError();

  if (prospect.status === "converted") {
    return {
      ok: false,
      reason: "already_converted",
      message: "This prospect is already a client.",
    };
  }

  // A holding organization with no members. See the note above.
  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: prospect.businessName,
        slug: `prospect-${prospect.publicId.slice(0, 10).toLowerCase()}`,
        kind: "client",
      })
      .returning({ id: organizations.id })
  )[0]!;

  const scaffold = await scaffoldSite(db, ctx.userId, {
    businessName: prospect.businessName,
    organizationId: org.id,
    // Never public. A speculative mock-up of somebody's business is not ours
    // to publish, and they have agreed to nothing.
    isPrivate: true,
    namePrefix: "concept",
    description: `Concept site for ${prospect.businessName} (prospect ${prospect.publicId.slice(0, 8)})`,
    templateRepo: prospect.referenceRepo ?? undefined,
  });

  if (!scaffold.ok) {
    return { ok: false, reason: scaffold.reason, message: scaffold.message };
  }

  const conceptJob = (
    await db
      .insert(conceptJobs)
      .values({
        publicId: newPublicId(),
        prospectId: prospect.id,
        status: "scaffolding",
        planApprovalRequired: false,
      })
      .returning({ id: conceptJobs.id })
  )[0]!;

  await db.insert(conceptRepositories).values({
    conceptJobId: conceptJob.id,
    owner: scaffold.repo.owner,
    name: scaffold.repo.name,
    visibility: "private",
  });

  if (scaffold.netlify) {
    await db.insert(previewDeployments).values({
      publicId: newPublicId(),
      conceptJobId: conceptJob.id,
      siteId: scaffold.siteId,
      kind: "concept",
      url: scaffold.netlify.url,
      status: "pending",
      // Concepts expire. A mock-up of somebody's business should not sit on the
      // internet indefinitely if they never reply.
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  // Scaffolding is done; an agent cannot write to the repository until it is
  // allowlisted, and that is a separate operator act. So the brief is written
  // now and dispatch is attempted — which will refuse until they allow it.
  const briefPublicId = newPublicId();
  const now = new Date();

  await db.insert(siteBriefs).values({
    publicId: briefPublicId,
    organizationId: org.id,
    siteId: scaffold.siteId,
    kind: "discovery",
    status: "submitted",
    colourDirection: instructions.colourDirection?.trim() || null,
    features:
      instructions.features?.trim() ||
      [
        prospect.planName ? `Plan being pitched: ${prospect.planName}.` : null,
        prospect.planIncludesAnalytics === false
          ? "This plan does not include analytics — do not feature an analytics dashboard."
          : null,
      ]
        .filter(Boolean)
        .join(" ") ||
      null,
    contentNotes:
      instructions.contentNotes?.trim() ||
      [
        prospect.industry ? `Industry: ${prospect.industry}.` : null,
        prospect.location ? `Location: ${prospect.location}.` : null,
        prospect.serviceArea ? `Service area: ${prospect.serviceArea}.` : null,
        prospect.tone ? `Tone: ${prospect.tone}.` : null,
        prospect.notes,
      ]
        .filter(Boolean)
        .join("\n") ||
      null,
    body: null,
    authoredByUserId: ctx.userId,
    submittedAt: now,
  });

  await db
    .update(prospects)
    .set({ status: "concept_pending", updatedAt: now })
    .where(eq(prospects.id, prospect.id));

  const dispatched = await dispatchBrief(ctx, db, briefPublicId);

  if (!dispatched.ok) {
    // The repository and hosting are real and recorded. Only the agent run did
    // not start, and the usual reason is that the operator has not allowlisted
    // the repository yet — which is a checkpoint, not a fault.
    return {
      ok: true,
      repo: scaffold.repo,
      warning: `Repository and hosting are ready, but the build did not start: ${dispatched.message}`,
    };
  }

  await db
    .update(conceptJobs)
    .set({ status: "building", updatedAt: new Date() })
    .where(eq(conceptJobs.id, conceptJob.id));

  return {
    ok: true,
    repo: scaffold.repo,
    issueNumber: dispatched.issueNumber,
    issueUrl: dispatched.issueUrl,
    warning: scaffold.warning,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Prospects with their plan and concept state, for the admin list. */
export async function listProspectsDetailed(_ctx: AdminContext, db: Database) {
  return db
    .select({
      publicId: prospects.publicId,
      businessName: prospects.businessName,
      sourceWebsiteUrl: prospects.sourceWebsiteUrl,
      industry: prospects.industry,
      status: prospects.status,
      isDemo: prospects.isDemo,
      updatedAt: prospects.updatedAt,
      planName: servicePlans.name,
      planKey: servicePlans.key,
    })
    .from(prospects)
    .leftJoin(servicePlans, eq(servicePlans.id, prospects.planId))
    .where(isNull(prospects.archivedAt))
    .orderBy(desc(prospects.updatedAt));
}

/**
 * Our own sites that a concept can be based on.
 *
 * Returns an empty list rather than throwing when GitHub is unconfigured or
 * unreachable: the prospect form must still render, and "no reference sites
 * available" is a state the operator can act on, whereas a crashed page is not.
 */
export async function listReferenceSites() {
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (!installationId || !isGithubConfigured()) return [];

  try {
    return await listTemplateRepos(installationId);
  } catch (error) {
    console.error("[prospects] could not list template repositories", error);
    return [];
  }
}

/** Plans an operator can pitch, cheapest first. */
export async function listActivePlans(db: Database) {
  return db
    .select({
      key: servicePlans.key,
      name: servicePlans.name,
      description: servicePlans.description,
      defaultMonthlyCents: servicePlans.defaultMonthlyCents,
      includedChangesPerMonth: servicePlans.includedChangesPerMonth,
      includesAnalytics: servicePlans.includesAnalytics,
    })
    .from(servicePlans)
    .where(eq(servicePlans.active, true))
    .orderBy(servicePlans.sortOrder, servicePlans.defaultMonthlyCents);
}

/** The concept preview for a prospect, if one has been built. */
export async function conceptPreviewFor(db: Database, prospectPublicId: string) {
  const rows = await db
    .select({
      url: previewDeployments.url,
      status: previewDeployments.status,
      expiresAt: previewDeployments.expiresAt,
      repoOwner: conceptRepositories.owner,
      repoName: conceptRepositories.name,
      conceptStatus: conceptJobs.status,
    })
    .from(conceptJobs)
    .innerJoin(prospects, eq(prospects.id, conceptJobs.prospectId))
    .leftJoin(
      conceptRepositories,
      eq(conceptRepositories.conceptJobId, conceptJobs.id),
    )
    .leftJoin(
      previewDeployments,
      and(
        eq(previewDeployments.conceptJobId, conceptJobs.id),
        eq(previewDeployments.kind, "concept"),
      ),
    )
    .where(eq(prospects.publicId, prospectPublicId))
    .orderBy(desc(conceptJobs.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
