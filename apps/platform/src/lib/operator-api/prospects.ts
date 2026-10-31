import { and, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { prospects } from "@/db/schema";
import type { AdminContext } from "@/db/repositories/context";
import {
  buildConcept,
  conceptPreviewFor,
  createProspect,
} from "@/db/repositories/admin/prospects";
import { nudgeScheduler } from "@/lib/scheduler/nudge";
import { OperatorApiError } from "./http";
import type { CreateProspectBody } from "./schemas";

/**
 * "Make me a site for …" (D6): a potential client and its concept site.
 *
 * `createProspect` and `buildConcept` are the functions the admin's own forms
 * call; this only sequences them and reads back the preview address. The one
 * thing added is the duplicate check, because the caller is an agent that may
 * retry a request it did not see answered, and each retry would otherwise be
 * another private repository and another Netlify site.
 */

export interface CreatedProspect {
  prospectId: string;
  previewUrl: string | null;
  concept:
    | { status: "not_requested" }
    | {
        status: "built";
        repository: string;
        repositoryUrl: string;
        previewUrl: string | null;
        issueUrl: string | null;
        warning: string | null;
      }
    | { status: "failed"; reason: string; message: string };
}

const PROSPECT_ERRORS = {
  invalid_name: 400,
  invalid_url: 400,
  unknown_plan: 400,
} as const;

async function findActiveNamesake(db: Database, businessName: string): Promise<string | null> {
  const [row] = await db
    .select({ publicId: prospects.publicId })
    .from(prospects)
    .where(
      and(
        isNull(prospects.archivedAt),
        ne(prospects.status, "converted"),
        sql`lower(${prospects.businessName}) = lower(${businessName.trim()})`,
      ),
    )
    .limit(1);
  return row?.publicId ?? null;
}

export async function createProspectWithConcept(
  ctx: AdminContext,
  db: Database,
  body: CreateProspectBody,
): Promise<CreatedProspect> {
  if (!body.allowDuplicate) {
    const existing = await findActiveNamesake(db, body.businessName);
    if (existing) {
      throw new OperatorApiError(
        409,
        "duplicate_prospect",
        "A potential client with this name is already on the list. Pass allowDuplicate: true to add another.",
        { prospectId: existing },
      );
    }
  }

  const created = await createProspect(ctx, db, body);
  if (!created.ok) {
    throw new OperatorApiError(PROSPECT_ERRORS[created.reason], created.reason, created.message);
  }

  if (!body.buildConcept) {
    return { prospectId: created.publicId, previewUrl: null, concept: { status: "not_requested" } };
  }

  const built = await buildConcept(ctx, db, created.publicId, body.concept ?? {});
  if (!built.ok) {
    // The potential client exists either way, so the caller gets its id and
    // can build the concept from the admin rather than create it again.
    return {
      prospectId: created.publicId,
      previewUrl: null,
      concept: { status: "failed", reason: built.reason, message: built.message },
    };
  }

  // A dispatched build has follow-ups (its pull request, its preview) that
  // the scheduler picks up; without a nudge they wait for the next sweep.
  if (built.issueUrl) nudgeScheduler("concept dispatched");

  const preview = await conceptPreviewFor(db, created.publicId);
  return {
    prospectId: created.publicId,
    previewUrl: preview?.url ?? null,
    concept: {
      status: "built",
      repository: `${built.repo.owner}/${built.repo.name}`,
      repositoryUrl: built.repo.htmlUrl,
      previewUrl: preview?.url ?? null,
      issueUrl: built.issueUrl ?? null,
      warning: built.warning ?? null,
    },
  };
}
