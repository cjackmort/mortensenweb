"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import {
  removeOwnAvatar,
  saveOwnBusinessProfile,
  setOwnAvatar,
  updateOwnDetails,
} from "@/db/repositories/client/profile";
import { CLIENT_PROFILE_FIELDS, PROFILE_FIELDS, parseProfileForm } from "@/lib/business-profile";
import { AVATAR_REJECTION_MESSAGES, prepareAvatar } from "@/lib/profile/avatar";
import { parseDetailsForm } from "@/lib/profile/details";

/**
 * The client's own profile: the picture, the person, the business.
 *
 * Each acts on the signed-in person — nothing here takes an id from the
 * form — and each revalidates the dashboard layout, because the top bar
 * shows the name and picture on every page.
 */

export type ProfileActionResult = {
  ok: boolean;
  message: string;
  /** Per-field problems, keyed by field, so the form can say which one. */
  errors?: Record<string, string>;
  /** What was submitted, so a refused form does not lose what was typed. */
  values?: Record<string, string>;
};

async function context() {
  const user = await currentUser();
  if (!user?.organizationId) return null;
  return { user, db: await getDb(), ctx: tenantContextFrom(user, user.organizationId) };
}

const READ_ONLY = "You are viewing this portal as the client, so nothing here can be changed.";

function refused(error: unknown): ProfileActionResult | null {
  if (error instanceof AuthorizationError) return { ok: false, message: READ_ONLY };
  if (error instanceof NotFoundError) return { ok: false, message: "Please sign in again." };
  return null;
}

export async function saveDetailsAction(
  _previous: ProfileActionResult | null,
  formData: FormData,
): Promise<ProfileActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const parsed = parseDetailsForm(formData);
  const values = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
  if (!parsed.ok) {
    return { ok: false, message: "Nothing was saved — check the fields marked.", errors: parsed.errors, values };
  }

  let result;
  try {
    result = await updateOwnDetails(session.db, session.ctx, parsed.input);
  } catch (error) {
    const known = refused(error);
    if (known) return known;
    throw error;
  }
  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      errors: result.field ? { [result.field]: result.message } : undefined,
      values,
    };
  }

  revalidatePath("/dashboard", "layout");
  if (result.changed.length === 0) return { ok: true, message: "Saved. Nothing had changed." };
  return {
    ok: true,
    message: result.changed.includes("email")
      ? "Saved. Sign in with your new email address from now on."
      : "Saved.",
  };
}

export async function uploadAvatarAction(
  _previous: ProfileActionResult | null,
  formData: FormData,
): Promise<ProfileActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a photo first." };
  }

  const prepared = await prepareAvatar(file);
  if (!prepared.ok) return { ok: false, message: AVATAR_REJECTION_MESSAGES[prepared.reason] };

  try {
    await setOwnAvatar(session.db, session.ctx, prepared.avatar);
  } catch (error) {
    const known = refused(error);
    if (known) return known;
    console.error("[profile] avatar upload failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, message: "Your photo couldn't be saved. Please try again in a minute." };
  }

  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Your picture is updated." };
}

export async function removeAvatarAction(
  _previous: ProfileActionResult | null,
): Promise<ProfileActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  try {
    await removeOwnAvatar(session.db, session.ctx);
  } catch (error) {
    const known = refused(error);
    if (known) return known;
    throw error;
  }

  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Your picture is removed." };
}

export async function saveBusinessAction(
  _previous: ProfileActionResult | null,
  formData: FormData,
): Promise<ProfileActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const parsed = parseProfileForm(formData);
  if (!parsed.ok) {
    // Named, because the field can be a long scroll up from the Save button.
    const labels = PROFILE_FIELDS.filter((f) => parsed.errors[f.key]).map((f) => f.label);
    return {
      ok: false,
      message: `Nothing was saved. Fix ${labels.length === 1 ? "this field" : "these fields"}: ${labels.join(", ")}.`,
      errors: parsed.errors,
      values: Object.fromEntries(
        CLIENT_PROFILE_FIELDS.map((field) => [field.key, String(formData.get(field.key) ?? "")]),
      ),
    };
  }

  let outcome;
  try {
    outcome = await saveOwnBusinessProfile(session.db, session.ctx, parsed.details);
  } catch (error) {
    const known = refused(error);
    if (known) return known;
    throw error;
  }

  revalidatePath("/dashboard/profile");
  if (outcome.changed.length === 0) return { ok: true, message: "Saved. Nothing had changed." };

  const labels = outcome.changed
    .map((key) => PROFILE_FIELDS.find((f) => f.key === key)?.label ?? key)
    .join(", ");
  return {
    ok: true,
    message:
      `Saved: ${labels}. Your website is not changed by itself — ` +
      (outcome.routingChanged.length > 0
        ? "a new phone number, email or booking link goes live only after we check it and you approve the preview. Send a request under Requests when you want it on the site."
        : "send a request under Requests when you want these details on the site."),
  };
}
