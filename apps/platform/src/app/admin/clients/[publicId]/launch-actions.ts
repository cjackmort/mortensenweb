"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  sendDnsInstructions,
  verifyAndGoLive,
} from "@/db/repositories/admin/launch";
import { allowlistRepository } from "@/db/repositories/admin/scaffold";

/**
 * The three launch controls.
 *
 * Kept as three buttons rather than a wizard because they are separated by days
 * and by someone else's actions. A wizard implies a session; this is a process
 * the operator dips in and out of while the client talks to their registrar.
 */

export type LaunchResult =
  | { ok: true; message: string; note?: string }
  | { ok: false; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") return null;
  return user;
}

export async function sendDnsAction(
  _previous: LaunchResult | null,
  formData: FormData,
): Promise<LaunchResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!sitePublicId) return { ok: false, message: "No site was specified." };

  const db = await getDb();
  const outcome = await sendDnsInstructions(adminContextFrom(user), db, sitePublicId);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: outcome.sent
      ? `DNS instructions sent for ${outcome.domain} (${outcome.recordCount} records).`
      : // Not a failure, but it must not read as a success either — in
        // development the mailer logs instead of sending.
        `Records prepared for ${outcome.domain}, but no email was sent — the mailer has no API key in this environment.`,
  };
}

export async function goLiveAction(
  _previous: LaunchResult | null,
  formData: FormData,
): Promise<LaunchResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!sitePublicId) return { ok: false, message: "No site was specified." };

  const db = await getDb();
  const outcome = await verifyAndGoLive(adminContextFrom(user), db, sitePublicId);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: `${outcome.domain} is verified and live. The client is now marked active${
      outcome.emailSent ? " and has been emailed" : ""
    }.`,
    note: outcome.analyticsNote,
  };
}

export async function toggleAutomationAction(
  _previous: LaunchResult | null,
  formData: FormData,
): Promise<LaunchResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  const allow = formData.get("allow") === "true";
  if (!sitePublicId) return { ok: false, message: "No site was specified." };

  const db = await getDb();
  const changed = await allowlistRepository(db, user.userId, sitePublicId, allow);

  revalidatePath(`/admin/clients/${clientPublicId}`);

  if (!changed) {
    return {
      ok: false,
      message: "This site has no connected repository to allowlist.",
    };
  }

  return {
    ok: true,
    message: allow
      ? "Automation enabled — agents can now open pull requests on this repository."
      : "Automation disabled. Nothing will be dispatched to this repository.",
  };
}
