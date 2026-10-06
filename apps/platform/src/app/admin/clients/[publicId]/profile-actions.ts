"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { organizationForClient } from "@/db/repositories/admin/briefs";
import { saveBusinessProfile } from "@/db/repositories/admin/business-profile";
import { sendProfileToSite } from "@/db/repositories/admin/profile-sync";
import { parseProfileForm, PROFILE_FIELDS } from "@/lib/business-profile";
import { normaliseSiteUrl, readProfileFromSite } from "@/lib/profile-autofill-fetch";

/**
 * The client's general information: saving it, and putting it on the site.
 *
 * Two actions because they are two decisions. Saving changes what every future
 * agent run is told; putting it on the site starts one now. An operator fixing
 * a typo in the hours should not have to start a build to keep the fix.
 */

export type ProfileResult = {
  ok: boolean;
  message: string;
  /** Per-field problems, keyed by field, so the form can say which one. */
  errors?: Record<string, string>;
  /** What was submitted, so a refused form does not lose what was typed. */
  values?: Record<string, string>;
};

export async function saveProfileAction(
  _previous: ProfileResult | null,
  formData: FormData,
): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can change a client's general information." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client was specified." };

  const parsed = parseProfileForm(formData);
  if (!parsed.ok) {
    const count = Object.keys(parsed.errors).length;
    return {
      ok: false,
      message: `Nothing was saved — ${count === 1 ? "one field needs" : `${count} fields need`} fixing.`,
      errors: parsed.errors,
      values: submittedValues(formData),
    };
  }

  const db = await getDb();
  const organizationId = await organizationForClient(db, clientPublicId);
  const { changed } = await saveBusinessProfile(adminContextFrom(user), db, organizationId, parsed.details);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  return {
    ok: true,
    message:
      changed.length === 0
        ? "Saved. Nothing had changed."
        : `Saved. Every agent run for this client now uses it. Changed: ${changed
            .map((key) => PROFILE_FIELDS.find((f) => f.key === key)?.label ?? key)
            .join(", ")}.`,
  };
}

export async function sendProfileAction(
  _previous: ProfileResult | null,
  formData: FormData,
): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can start work on a site." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  if (!clientPublicId || !sitePublicId) {
    return { ok: false, message: "Choose the site to update." };
  }

  const db = await getDb();
  const organizationId = await organizationForClient(db, clientPublicId);
  const outcome = await sendProfileToSite(adminContextFrom(user), db, { organizationId, sitePublicId });

  revalidatePath(`/admin/clients/${clientPublicId}`);
  revalidatePath("/admin/requests");

  return { ok: outcome.ok, message: outcome.message };
}

function submittedValues(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    PROFILE_FIELDS.map((field) => [field.key, String(formData.get(field.key) ?? "")]),
  );
}

export type AutofillResult =
  | { ok: true; message: string; found: Record<string, string>; siteUrl: string }
  | { ok: false; message: string; siteUrl?: string };

/**
 * Read their existing website and offer what it says.
 *
 * Returns suggestions only. The form puts them in empty fields, marked, and
 * nothing is stored until the operator presses Save.
 */
export async function autofillProfileAction(
  _previous: AutofillResult | null,
  formData: FormData,
): Promise<AutofillResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const siteUrl = normaliseSiteUrl(String(formData.get("siteUrl") ?? ""));
  if (!siteUrl) return { ok: false, message: "Enter their website address." };

  const outcome = await readProfileFromSite(siteUrl);
  if (!outcome.ok) return { ...outcome, siteUrl };

  const count = Object.keys(outcome.found).length;
  return {
    ok: true,
    found: outcome.found,
    siteUrl,
    message:
      count === 0
        ? "Their site didn't say anything we could use. Fill it in by hand."
        : `Found ${count} detail${count === 1 ? "" : "s"} on ${outcome.pagesRead} page${outcome.pagesRead === 1 ? "" : "s"}. They're in the empty fields below, marked. Check them, then save.`,
  };
}
