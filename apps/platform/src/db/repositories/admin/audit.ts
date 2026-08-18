import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditedPages,
  businessFacts,
  prospects,
  siteAuditJobs,
} from "@/db/schema";
import { auditLog } from "@/db/schema";
import { fetchPublicPage } from "@/lib/crawl/fetch";
import { isAllowedByRobots, parseRobots, type RobotsRules } from "@/lib/crawl/robots";
import { extractFacts, extractPage } from "@/lib/crawl/extract";
import { inspectUrl } from "@/lib/crawl/ssrf";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";

/**
 * Auditing a prospect's current website.
 *
 * This is the step Stage 0 §7.2 numbers 2 through 5, and the one the plan's
 * Known Gaps recorded as missing — briefs were typed by hand because nothing
 * ever read the site they described.
 *
 * Three properties matter more than the crawling itself:
 *
 * **Every fetch goes through `fetchPublicPage`.** There is no other way out to
 * the network from here, so the SSRF controls cannot be bypassed by adding a
 * feature later that "just needs one more request".
 *
 * **Everything it reads is stored as unverified.** A crawled fact is a
 * candidate. Only an operator accepting one makes it renderable, and this
 * module has no code path that can set `user_verified` — that lives in
 * `recordFactVerdict`, which requires a person.
 *
 * **It is bounded before it starts.** Page and depth caps are columns with
 * check constraints, not parameters someone can talk upward at the call site.
 */

export type AuditOutcome =
  | { ok: true; auditJobId: string; pagesFetched: number; factsFound: number }
  | { ok: false; reason: "bad_url" | "no_prospect" | "blocked"; message: string };

export interface AuditInput {
  prospectPublicId: string;
  /** Bounded by a check constraint at 1–200; the default is deliberately small. */
  maxPages?: number;
  maxDepth?: number;
}

export async function auditProspectSite(
  ctx: AdminContext,
  db: Database,
  input: AuditInput,
): Promise<AuditOutcome> {
  const rows = await db
    .select({
      id: prospects.id,
      publicId: prospects.publicId,
      websiteUrl: prospects.sourceWebsiteUrl,
    })
    .from(prospects)
    .where(eq(prospects.publicId, input.prospectPublicId))
    .limit(1);

  const prospect = rows[0];
  if (!prospect) {
    return { ok: false, reason: "no_prospect", message: "No such prospect." };
  }
  if (!prospect.websiteUrl) {
    return {
      ok: false,
      reason: "bad_url",
      message: "This prospect has no website recorded to audit.",
    };
  }

  // Checked before a job row exists: an operator who pasted an http:// URL or a
  // private address should get told immediately, not find a failed job later.
  const shape = inspectUrl(prospect.websiteUrl);
  if (!shape.ok) {
    return {
      ok: false,
      reason: "blocked",
      message: shape.detail ?? "That URL cannot be audited.",
    };
  }

  const maxPages = clamp(input.maxPages ?? 15, 1, 200);
  const maxDepth = clamp(input.maxDepth ?? 2, 1, 10);

  const jobRows = await db
    .insert(siteAuditJobs)
    .values({
      publicId: newPublicId(),
      prospectId: prospect.id,
      status: "running",
      requestedBy: ctx.userId,
      maxPages,
      maxDepth,
      robotsRespected: true,
      startedAt: new Date(),
    })
    .returning();

  const job = jobRows[0];
  if (!job) throw new Error("Insert returned no row.");

  try {
    const result = await crawl(prospect.websiteUrl, { maxPages, maxDepth });

    for (const page of result.pages) {
      await db
        .insert(auditedPages)
        .values({
          auditJobId: job.id,
          url: page.url,
          statusCode: page.statusCode,
          title: page.title,
          metaDescription: page.metaDescription,
          h1: page.h1,
          canonical: page.canonical,
          contentHash: page.contentHash,
        })
        // A redirect can land two frontier entries on one URL. The unique index
        // is on (job, url), so the second is a no-op rather than a failed job.
        .onConflictDoNothing();
    }

    for (const fact of result.facts) {
      await db.insert(businessFacts).values({
        prospectId: prospect.id,
        auditJobId: job.id,
        key: fact.key,
        value: fact.value,
        sourceUrl: fact.sourceUrl,
        sourceType: "crawl",
        // `sensitive` is a terminal classification, not a starting point: these
        // are never auto-published whatever an operator later clicks, so they
        // are marked at write time rather than left to the review screen.
        verification: fact.sensitive ? "sensitive" : "unverified",
        confidence: fact.confidence,
      });
    }

    await db
      .update(siteAuditJobs)
      .set({
        status: "succeeded",
        pagesFetched: result.pages.length,
        finishedAt: new Date(),
      })
      .where(eq(siteAuditJobs.id, job.id));

    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "prospect.audited",
      entityType: "prospect",
      entityId: prospect.publicId,
      metadata: {
        url: prospect.websiteUrl,
        pages: result.pages.length,
        facts: result.facts.length,
        refusals: result.refusals,
      },
    });

    return {
      ok: true,
      auditJobId: job.publicId,
      pagesFetched: result.pages.length,
      factsFound: result.facts.length,
    };
  } catch (error) {
    await db
      .update(siteAuditJobs)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown failure.",
        finishedAt: new Date(),
      })
      .where(eq(siteAuditJobs.id, job.id));

    throw error;
  }
}

interface CrawledPage {
  url: string;
  statusCode: number;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  contentHash: string;
}

interface CrawlResult {
  pages: CrawledPage[];
  facts: Array<{
    key: string;
    value: string;
    sourceUrl: string;
    sensitive: boolean;
    confidence: number;
  }>;
  /** URLs we declined to fetch, and why. Recorded so a thin audit is explicable. */
  refusals: Array<{ url: string; reason: string }>;
}

/**
 * Breadth-first, same origin, bounded, polite.
 *
 * Breadth-first rather than depth-first because the pages that describe a
 * business — home, about, services, contact — are almost always one click from
 * the front door, and a depth-first walk spends its budget deep in a blog.
 */
async function crawl(
  startUrl: string,
  limits: { maxPages: number; maxDepth: number },
): Promise<CrawlResult> {
  const origin = new URL(startUrl).origin;
  const robots = await loadRobots(origin);

  const seen = new Set<string>();
  const frontier: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];

  const pages: CrawledPage[] = [];
  const facts: CrawlResult["facts"] = [];
  const refusals: CrawlResult["refusals"] = [];

  while (frontier.length > 0 && pages.length < limits.maxPages) {
    const next = frontier.shift();
    if (!next) break;

    const normalised = next.url.replace(/#.*$/, "");
    if (seen.has(normalised)) continue;
    seen.add(normalised);

    const path = new URL(normalised).pathname;
    if (!isAllowedByRobots(path, robots)) {
      refusals.push({ url: normalised, reason: "robots.txt" });
      continue;
    }

    const fetched = await fetchPublicPage(normalised);
    if (!fetched.ok) {
      refusals.push({ url: normalised, reason: fetched.reason });
      continue;
    }

    const page = extractPage(fetched.html, fetched.finalUrl);

    pages.push({
      url: fetched.finalUrl,
      statusCode: fetched.status,
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      canonical: page.canonical,
      contentHash: await hash(fetched.html),
    });

    for (const fact of extractFacts(page, fetched.html)) {
      facts.push({ ...fact, sourceUrl: fetched.finalUrl });
    }

    if (next.depth < limits.maxDepth) {
      for (const link of page.links) {
        if (!seen.has(link) && link.startsWith(origin)) {
          frontier.push({ url: link, depth: next.depth + 1 });
        }
      }
    }

    // A courtesy pause. We are reading a small business's site to sell to them;
    // arriving as a burst of parallel requests is a poor opening.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { pages, facts, refusals };
}

/**
 * Absent or unreadable robots.txt means no restrictions.
 *
 * That is the convention, and the conservative alternative — refusing to crawl
 * when the file is missing — would refuse most small business sites, which is
 * the entire market.
 */
async function loadRobots(origin: string): Promise<RobotsRules> {
  const fetched = await fetchPublicPage(`${origin}/robots.txt`);
  if (!fetched.ok) return { disallow: [], allow: [] };
  return parseRobots(fetched.html);
}

async function hash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.trunc(value), low), high);
}

/** Facts found for a prospect, newest audit first. Backs the review screen. */
export async function listFactsForProspect(
  _ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
) {
  return db
    .select({
      id: businessFacts.id,
      key: businessFacts.key,
      value: businessFacts.value,
      sourceUrl: businessFacts.sourceUrl,
      verification: businessFacts.verification,
      confidence: businessFacts.confidence,
    })
    .from(businessFacts)
    .innerJoin(prospects, eq(prospects.id, businessFacts.prospectId))
    .where(eq(prospects.publicId, prospectPublicId))
    .orderBy(desc(businessFacts.confidence));
}

/**
 * An operator accepting or rejecting a crawled fact.
 *
 * The only path to `user_verified`, and the reason the generator can be trusted
 * to render anything at all. A `sensitive` fact cannot be promoted here — those
 * are never auto-published regardless of who clicks what, so the guard is a
 * refusal in code rather than a convention in the UI.
 */
export async function recordFactVerdict(
  ctx: AdminContext,
  db: Database,
  factId: string,
  verdict: "user_verified" | "conflicting",
): Promise<{ ok: boolean; message: string }> {
  const rows = await db
    .select({ id: businessFacts.id, verification: businessFacts.verification, key: businessFacts.key })
    .from(businessFacts)
    .where(eq(businessFacts.id, factId))
    .limit(1);

  const fact = rows[0];
  if (!fact) return { ok: false, message: "No such fact." };

  if (fact.verification === "sensitive") {
    return {
      ok: false,
      message:
        "This is a claim we never publish automatically — a licence number, price, guarantee or similar. Put it on the site by hand once you have confirmed it with the owner.",
    };
  }

  await db
    .update(businessFacts)
    .set({ verification: verdict })
    .where(eq(businessFacts.id, fact.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "prospect.fact_verdict",
    entityType: "business_fact",
    entityId: factId,
    metadata: { key: fact.key, verdict },
  });

  return { ok: true, message: verdict === "user_verified" ? "Confirmed." : "Marked as wrong." };
}

/** The most recent audit for a prospect, for the admin screen's status line. */
export async function latestAudit(
  _ctx: AdminContext,
  db: Database,
  prospectPublicId: string,
) {
  const rows = await db
    .select({
      publicId: siteAuditJobs.publicId,
      status: siteAuditJobs.status,
      pagesFetched: siteAuditJobs.pagesFetched,
      error: siteAuditJobs.error,
      finishedAt: siteAuditJobs.finishedAt,
      createdAt: siteAuditJobs.createdAt,
    })
    .from(siteAuditJobs)
    .innerJoin(prospects, eq(prospects.id, siteAuditJobs.prospectId))
    .where(and(eq(prospects.publicId, prospectPublicId)))
    .orderBy(desc(siteAuditJobs.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
