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

  const outcome = await buildConcept(ctx, db, prospectPublicId, {
    colourDirection: String(formData.get("colourDirection") ?? ""),
    features: String(formData.get("features") ?? ""),
    contentNotes: String(formData.get("contentNotes") ?? ""),
  });

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
