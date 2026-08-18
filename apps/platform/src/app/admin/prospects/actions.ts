"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { buildConcept, createProspect } from "@/db/repositories/admin/prospects";
import {
  approveAndShareConcept,
  revokeShares,
} from "@/db/repositories/admin/shares";
import {
  auditProspectSite,
  recordFactVerdict,
} from "@/db/repositories/admin/audit";

/**
 * Operator actions on the front of the funnel.
 *
 * Note what is absent: there is no action here that sends anything to anyone.
 * `shareConceptAction` mints a link and hands it back to the operator, who
 * decides what to do with it. Stage 0 §7.2 forbids automated prospect contact,
 * and the way to keep that promise structurally is to have no code that could.
 */

export type ProspectResult =
  | { ok: true; message: string; url?: string; warning?: string }
  | { ok: false; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user) return null;
  if (user.role !== "admin") return null;
  return user;
}

export async function createProspectAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can add a prospect." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const outcome = await createProspect(ctx, db, {
    businessName: String(formData.get("businessName") ?? ""),
    sourceWebsiteUrl: String(formData.get("sourceWebsiteUrl") ?? ""),
    industry: String(formData.get("industry") ?? ""),
    location: String(formData.get("location") ?? ""),
    serviceArea: String(formData.get("serviceArea") ?? ""),
    tone: String(formData.get("tone") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    planKey: String(formData.get("planKey") ?? "") || undefined,
    referenceRepo: String(formData.get("referenceRepo") ?? "") || undefined,
    contactName: String(formData.get("contactName") ?? ""),
    contactEmail: String(formData.get("contactEmail") ?? ""),
    contactPhone: String(formData.get("contactPhone") ?? ""),
    consentNote: String(formData.get("consentNote") ?? ""),
  });

  revalidatePath("/admin/prospects");

  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, message: "Prospect added." };
}

export async function buildConceptAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can build a concept." };

  const prospectPublicId = String(formData.get("prospectPublicId") ?? "").trim();
  if (!prospectPublicId) return { ok: false, message: "No prospect was specified." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  // Everything below runs against two external services and a database, and
  // any of them can fail in a way that throws. Unguarded, that renders Next's
  // error page — which loses the operator's typed input and says only "a
  // server error occurred", with the real cause in a log they cannot read.
  let outcome;
  try {
    outcome = await buildConcept(ctx, db, prospectPublicId, {
      colourDirection: String(formData.get("colourDirection") ?? ""),
      features: String(formData.get("features") ?? ""),
      contentNotes: String(formData.get("contentNotes") ?? ""),
    });
  } catch (error) {
    console.error("[prospects] concept build threw", error);
    return {
      ok: false,
      message: `The build failed: ${
        error instanceof Error ? error.message : "unknown error"
      }. Anything already created is recorded — check the prospect before retrying.`,
    };
  }

  revalidatePath("/admin/prospects");

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: `Repository ${outcome.repo.owner}/${outcome.repo.name} created${
      outcome.issueNumber ? ` and build started (issue #${outcome.issueNumber})` : ""
    }.`,
    url: outcome.issueUrl,
    warning: outcome.warning,
  };
}

export async function shareConceptAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can approve a concept." };

  const prospectPublicId = String(formData.get("prospectPublicId") ?? "").trim();
  if (!prospectPublicId) return { ok: false, message: "No prospect was specified." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const outcome = await approveAndShareConcept(ctx, db, prospectPublicId);

  revalidatePath("/admin/prospects");

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    // The token is shown exactly once, here. It is stored only as a hash, so
    // there is no way to display it again — which is the point, and worth
    // saying plainly to the operator rather than letting them discover it.
    message: `Approved. Copy this link now — it isn't shown again, and it expires ${outcome.expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric" })}.`,
    url: outcome.url,
  };
}

export async function revokeSharesAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can revoke a link." };

  const prospectPublicId = String(formData.get("prospectPublicId") ?? "").trim();
  if (!prospectPublicId) return { ok: false, message: "No prospect was specified." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const count = await revokeShares(ctx, db, prospectPublicId);

  revalidatePath("/admin/prospects");

  return {
    ok: true,
    message:
      count === 0
        ? "There were no live links to revoke."
        : `Revoked ${count} ${count === 1 ? "link" : "links"}.`,
  };
}

/**
 * Read a prospect's current website and extract candidate facts.
 *
 * Nothing here reaches the prospect and nothing touches their site beyond
 * fetching public pages as an anonymous visitor. Everything it finds is stored
 * unverified and waits for the operator's verdict below.
 */
export async function auditProspectAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can audit a site." };

  const prospectPublicId = String(formData.get("prospectPublicId") ?? "").trim();
  if (!prospectPublicId) return { ok: false, message: "No prospect was specified." };

  const ctx = adminContextFrom(user);
  const db = await getDb();

  try {
    const outcome = await auditProspectSite(ctx, db, { prospectPublicId });
    revalidatePath("/admin/prospects");

    if (!outcome.ok) return { ok: false, message: outcome.message };

    return {
      ok: true,
      message: `Read ${outcome.pagesFetched} ${outcome.pagesFetched === 1 ? "page" : "pages"} and found ${outcome.factsFound} things to check.`,
    };
  } catch (error) {
    // A crawl failure is an operational matter, not a stack trace to show an
    // operator mid-task. The job row already carries the detail.
    console.error("[prospects] audit failed", {
      prospectPublicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      message: "The audit could not finish. The job record has the detail.",
    };
  }
}

/**
 * Confirming or rejecting one crawled fact.
 *
 * The only route to `user_verified`, which is the only state a generated site
 * may render. A `sensitive` fact is refused here whatever is clicked.
 */
export async function factVerdictAction(
  _previous: ProspectResult | null,
  formData: FormData,
): Promise<ProspectResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can confirm a fact." };

  const factId = String(formData.get("factId") ?? "").trim();
  const verdict = String(formData.get("verdict") ?? "");
  if (!factId) return { ok: false, message: "No fact was specified." };
  if (verdict !== "user_verified" && verdict !== "conflicting") {
    return { ok: false, message: "Unrecognised verdict." };
  }

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const outcome = await recordFactVerdict(ctx, db, factId, verdict);
  revalidatePath("/admin/prospects");
  return outcome.ok
    ? { ok: true, message: outcome.message }
    : { ok: false, message: outcome.message };
}
