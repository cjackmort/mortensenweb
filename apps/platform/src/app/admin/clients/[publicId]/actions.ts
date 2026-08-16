"use server";

import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  ActivationError,
  activateClient,
  reissueTemporaryPassword,
} from "@/db/repositories/admin/activation";
import {
  findOrganizationUserId,
  getClientDetail,
} from "@/db/repositories/admin/clients";
import { portalOrigin } from "@/lib/auth/reset";
import { sendEmail } from "@/lib/email/mailer";
import { buildWelcomeEmail } from "@/lib/email/welcome";

/**
 * Credential actions for one client.
 *
 * Both actions hand back a plaintext temporary password that is deliberately
 * never stored — `activateClient` hashes it on the way in and returns the only
 * copy. That single fact drives the shape of this module:
 *
 *  - The credential is returned in the action's **result**, not via `redirect`.
 *    A query parameter would put a live password into browser history, the
 *    Referer header, and any access log in front of the app.
 *  - It is not written to a cookie or to session storage either. It exists in
 *    the POST response body and in React state, and disappears on navigation —
 *    which is why the UI tells the operator to copy it before leaving.
 *  - It is never logged. The audit rows written by the repository record *that*
 *    a credential was issued, never what it was.
 *
 * Every action re-derives the admin context from the session. The page already
 * gates on `role === "admin"`, but a server action is a public POST endpoint:
 * anything that trusts the page's check is directly callable by a client
 * account.
 */

export type CredentialResult =
  | {
      ok: true;
      kind: "activated" | "reissued";
      username: string;
      temporaryPassword: string;
      email: string;
      expiresAt: string;
      emailStatus: "sent" | "skipped" | "failed";
    }
  | { ok: false; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    throw new NotFoundError();
  }
  return adminContextFrom(user);
}

function expiryLabel(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
  });
}

export async function activateClientAction(
  _previous: CredentialResult | null,
  formData: FormData,
): Promise<CredentialResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const contactName = String(formData.get("contactName") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const sendWelcome = formData.get("sendWelcome") === "on";

  if (!contactEmail) {
    return { ok: false, message: "An email address is required." };
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

  let result;
  try {
    result = await activateClient(ctx, db, {
      organizationId: detail.organization.id,
      contactName,
      contactEmail,
    });
  } catch (error) {
    // These are operator-fixable states, not faults. `email_in_use` in
    // particular is the common one: the right action then is reissue, not
    // activate, and saying so is more useful than "something went wrong".
    if (error instanceof ActivationError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  if (sendWelcome) {
    const message = buildWelcomeEmail({
      businessName: detail.organization.name,
      contactName: contactName || null,
      username: result.username,
      temporaryPassword: result.temporaryPassword,
      portalUrl: portalOrigin(),
      expiresAt: result.expiresAt,
    });
    const send = await sendEmail({ ...message, to: result.email });
    emailStatus = send.status === "sent" ? "sent" : send.status;
  }

  // NO `revalidatePath` here, deliberately.
  //
  // Revalidating re-renders the server component, which now sees a portal user
  // and switches from the "activate" branch to the "reissue" branch. That
  // unmounts `ActivateForm` — and with it the React state holding the only copy
  // of the temporary password, which is never stored and cannot be recovered.
  // The operator would be left having to reissue immediately.
  //
  // Stale page data until the next manual refresh is a trivial cost next to
  // destroying the credential the operation exists to produce.

  return {
    ok: true,
    kind: "activated",
    username: result.username,
    temporaryPassword: result.temporaryPassword,
    email: result.email,
    expiresAt: expiryLabel(result.expiresAt),
    emailStatus,
  };
}

export async function reissueCredentialAction(
  _previous: CredentialResult | null,
  formData: FormData,
): Promise<CredentialResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const userPublicId = String(formData.get("userPublicId") ?? "");
  const sendWelcome = formData.get("sendWelcome") === "on";

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That client no longer exists." };
    }
    throw error;
  }

  let userId: string;
  try {
    // Scoped by organization: a public id belonging to another client's user
    // resolves to "not found" rather than reissuing their credential.
    userId = await findOrganizationUserId(
      ctx,
      db,
      detail.organization.id,
      userPublicId,
    );
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That account is not on this client." };
    }
    throw error;
  }

  const result = await reissueTemporaryPassword(ctx, db, userId);

  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  if (sendWelcome) {
    const message = buildWelcomeEmail({
      businessName: detail.organization.name,
      contactName: detail.client.primaryContactName,
      username: result.username,
      temporaryPassword: result.temporaryPassword,
      portalUrl: portalOrigin(),
      expiresAt: result.expiresAt,
    });
    const send = await sendEmail({ ...message, to: result.email });
    emailStatus = send.status === "sent" ? "sent" : send.status;
  }

  // Same reasoning as `activateClientAction`: revalidating can remount the form
  // and discard the only copy of the password. Refreshing is the operator's
  // call, once they have copied it.

  return {
    ok: true,
    kind: "reissued",
    username: result.username,
    temporaryPassword: result.temporaryPassword,
    email: result.email,
    expiresAt: expiryLabel(result.expiresAt),
    emailStatus,
  };
}
