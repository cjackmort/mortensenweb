"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getClientDetail } from "@/db/repositories/admin/clients";
import {
  addSite,
  requireOrganizationSite,
  setAnalyticsConnection,
  setSitePreviewMode,
} from "@/db/repositories/admin/sites";

/**
 * Site and analytics actions.
 *
 * Unlike the credential actions in `actions.ts`, these DO revalidate: nothing
 * here returns a one-time secret, so refreshing the page is purely helpful.
 *
 * Both re-derive the admin context from the session. A server action is a
 * public POST endpoint — the page's role check protects the page, not this.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type SiteActionResult = { ok: true } | { ok: false; message: string };

export async function addSiteAction(
  _previous: SiteActionResult | null,
  formData: FormData,
): Promise<SiteActionResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const name = String(formData.get("siteName") ?? "").trim();
  const domain = String(formData.get("primaryDomain") ?? "").trim();

  if (name.length < 2) {
    return { ok: false, message: "Please give the site a name." };
  }

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That client no longer exists." };
    }
    throw error;
  }

  await addSite(ctx, db, {
    organizationId: detail.organization.id,
    name,
    primaryDomain: domain || undefined,
  });

  revalidatePath(`/admin/clients/${clientPublicId}`);
  return { ok: true };
}

export async function setPreviewModeAction(
  _previous: SiteActionResult | null,
  formData: FormData,
): Promise<SiteActionResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const sitePublicId = String(formData.get("sitePublicId") ?? "");
  const mode = String(formData.get("previewMode") ?? "");

  if (mode !== "screenshot" && mode !== "live") {
    return { ok: false, message: "Pick a thumbnail source." };
  }

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That client no longer exists." };
    }
    throw error;
  }

  // Same scoping as the analytics action: a site id from another client
  // cannot be retargeted from this page.
  try {
    await requireOrganizationSite(ctx, db, detail.organization.id, sitePublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That site is not on this client." };
    }
    throw error;
  }

  const result = await setSitePreviewMode(ctx, db, sitePublicId, mode);
  if (!result.ok) {
    return { ok: false, message: "That site no longer exists." };
  }

  // Both grids draw from this column, so both are stale until revalidated.
  revalidatePath(`/admin/clients/${clientPublicId}`);
  revalidatePath("/admin/clients");
  revalidatePath("/admin");
  return { ok: true };
}

export async function connectAnalyticsAction(
  _previous: SiteActionResult | null,
  formData: FormData,
): Promise<SiteActionResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const sitePublicId = String(formData.get("sitePublicId") ?? "");
  const websiteId = String(formData.get("umamiWebsiteId") ?? "");

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That client no longer exists." };
    }
    throw error;
  }

  // Scoped to this client's organization, so a site id belonging to another
  // client cannot be connected from this page.
  try {
    await requireOrganizationSite(
      ctx,
      db,
      detail.organization.id,
      sitePublicId,
    );
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That site is not on this client." };
    }
    throw error;
  }

  const result = await setAnalyticsConnection(ctx, db, sitePublicId, websiteId);

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "invalid_id"
          ? "That doesn't look like a Umami website ID. It should be a UUID, like 0b1c2d3e-4f56-7890-abcd-ef1234567890 — copy it from the website's settings in Umami."
          : "That site no longer exists.",
    };
  }

  revalidatePath(`/admin/clients/${clientPublicId}`);
  return { ok: true };
}
