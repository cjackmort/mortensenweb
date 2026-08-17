import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  approvals,
  auditLog,
  conceptJobs,
  previewDeployments,
  prospectShares,
  prospects,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Showing a concept to the business it was built for.
 *
 * The process says "automatically send the demo, after approval from me". The
 * approval is where the automation stops and a person starts, and it is
 * recorded in `approvals` with a named user and a timestamp — not as a boolean
 * somewhere, because "who decided to send an unsolicited mock-up of this
 * company's website to them, and when" is a question that should have an answer.
 *
 * Stage 0 §7.2 forbids automated prospect contact outright. That still holds:
 * nothing in this module or anywhere in the prospect pipeline sends anything.
 * This mints a link. What the operator does with it is their act.
 *
 * ## The token
 *
 * Only a SHA-256 hash of the token is stored. A database disclosure therefore
 * does not yield working links to every concept ever built — which matters more
 * than usual here, because those concepts are private mock-ups of real
 * businesses that never asked for one.
 */

const DEFAULT_TTL_DAYS = 14;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A 256-bit token, URL-safe.
 *
 * Long enough that guessing is not a strategy, and generated from a CSPRNG
 * rather than `Math.random` — this is the only thing standing between a URL and
 * a private concept.
 */
export function generateShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ShareOutcome =
  | { ok: true; url: string; token: string; expiresAt: Date }
  | { ok: false; reason: "no_concept" | "not_ready"; message: string };

/**
 * Approve a concept and mint a share link.
 *
 * One function because they are one decision: an operator looking at a demo and
 * saying "yes, show them this". Splitting them would allow the state where a
 * concept is approved and unshared, or — much worse — shared and unapproved.
 */
export async function approveAndShareConcept(
  ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
  { ttlDays = DEFAULT_TTL_DAYS }: { ttlDays?: number } = {},
): Promise<ShareOutcome> {
  const rows = await db
    .select({
      prospectId: prospects.id,
      businessName: prospects.businessName,
      conceptJobId: conceptJobs.id,
      previewUrl: previewDeployments.url,
    })
    .from(prospects)
    .leftJoin(conceptJobs, eq(conceptJobs.prospectId, prospects.id))
    .leftJoin(
      previewDeployments,
      and(
        eq(previewDeployments.conceptJobId, conceptJobs.id),
        eq(previewDeployments.kind, "concept"),
      ),
    )
    .where(eq(prospects.publicId, prospectPublicId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();

  if (!row.conceptJobId) {
    return {
      ok: false,
      reason: "no_concept",
      message: "There's no concept to share yet — build one first.",
    };
  }
  if (!row.previewUrl) {
    return {
      ok: false,
      reason: "not_ready",
      message: "The concept has no preview URL yet. Wait for the build to finish.",
    };
  }

  const token = generateShareToken();
  const tokenHash = await hashShareToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  await db.insert(prospectShares).values({
    prospectId: row.prospectId,
    tokenHash,
    expiresAt,
    createdBy: ctx.userId,
  });

  // The approval record. `decidedAt` and `decision` move together — the schema
  // refuses a decision without a time, so "approved by nobody at no point"
  // cannot be written.
  await db.insert(approvals).values({
    publicId: newPublicId(),
    subjectType: "concept_job",
    subjectId: row.conceptJobId,
    kind: "public_display",
    decision: "approved",
    decidedBy: ctx.userId,
    decidedAt: now,
    note: `Shared with ${row.businessName}`,
  });

  await db
    .update(prospects)
    .set({ status: "shared", updatedAt: now })
    .where(eq(prospects.id, row.prospectId));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "prospect.concept_shared",
    entityType: "prospect",
    entityId: prospectPublicId,
    // The token is never logged. An audit row that contains a working
    // credential is a second copy of the secret.
    metadata: { expiresAt: expiresAt.toISOString(), ttlDays },
  });

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.AUTH_URL ?? "";
  return {
    ok: true,
    url: `${base.replace(/\/$/, "")}/preview/${token}`,
    token,
    expiresAt,
  };
}

export interface ResolvedShare {
  businessName: string;
  previewUrl: string;
}

/**
 * Resolve a share token to the concept it points at.
 *
 * Unauthenticated — this is the one route a prospect reaches without an account
 * — so every reason to refuse collapses into `null`. Distinguishing "expired"
 * from "revoked" from "never existed" in the response would confirm which
 * tokens were once real.
 *
 * The view counter is incremented as a side effect. It answers a question the
 * operator actually asks ("did they look at it?") before following up.
 */
export async function resolveShareToken(
  db: Database,
  token: string,
): Promise<ResolvedShare | null> {
  if (!token || token.length < 20) return null;

  const tokenHash = await hashShareToken(token);

  const rows = await db
    .select({
      shareId: prospectShares.id,
      businessName: prospects.businessName,
      previewUrl: previewDeployments.url,
    })
    .from(prospectShares)
    .innerJoin(prospects, eq(prospects.id, prospectShares.prospectId))
    .leftJoin(conceptJobs, eq(conceptJobs.prospectId, prospects.id))
    .leftJoin(
      previewDeployments,
      and(
        eq(previewDeployments.conceptJobId, conceptJobs.id),
        eq(previewDeployments.kind, "concept"),
      ),
    )
    .where(
      and(
        eq(prospectShares.tokenHash, tokenHash),
        isNull(prospectShares.revokedAt),
        gt(prospectShares.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.previewUrl) return null;

  await db
    .update(prospectShares)
    .set({ viewedCount: sql`${prospectShares.viewedCount} + 1` })
    .where(eq(prospectShares.id, row.shareId));

  return { businessName: row.businessName, previewUrl: row.previewUrl };
}

/** Revoke every live link for a prospect. */
export async function revokeShares(
  ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
): Promise<number> {
  const rows = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(eq(prospects.publicId, prospectPublicId))
    .limit(1);

  const prospect = rows[0];
  if (!prospect) throw new NotFoundError();

  const revoked = await db
    .update(prospectShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(prospectShares.prospectId, prospect.id),
        isNull(prospectShares.revokedAt),
      ),
    )
    .returning({ id: prospectShares.id });

  if (revoked.length > 0) {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "prospect.shares_revoked",
      entityType: "prospect",
      entityId: prospectPublicId,
      metadata: { count: revoked.length },
    });
  }

  return revoked.length;
}
