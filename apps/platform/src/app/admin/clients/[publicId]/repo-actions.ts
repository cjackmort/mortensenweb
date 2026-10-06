"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { connectExistingRepo } from "@/db/repositories/admin/connect-repo";
import { allowlistRepository } from "@/db/repositories/admin/scaffold";
import {
  describeTokenInstall,
  describeWorkflowInstall,
  installAgentWorkflow,
  installRepoTokens,
} from "@/db/repositories/admin/repo-tokens";
import type { Database } from "@/db/client";

/**
 * Connecting a repository that already exists, and authorising work on it.
 *
 * Two actions rather than one, mirroring the repository layer: recording that a
 * repository belongs to a site is a different decision from letting an agent
 * write to it, and an operator should have to make the second one on purpose.
 */

export type RepoActionResult = { ok: boolean; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") return null;
  return user;
}

export async function connectRepoAction(
  _previous: RepoActionResult | null,
  formData: FormData,
): Promise<RepoActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };
  const ctx = adminContextFrom(user);
  const db = await getDb();

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const raw = String(formData.get("repo") ?? "").trim();
  const style = String(formData.get("previewUrlStyle") ?? "pr_alias");
  const netlifySiteName = String(formData.get("netlifySiteName") ?? "").trim();

  if (!sitePublicId || !raw) {
    return { ok: false, message: "Pick a site and enter a repository." };
  }

  // Accept what an operator is likely to paste: a full URL, or owner/name.
  // Rejecting a github.com URL would be pedantry — it names the repository
  // unambiguously, and copying it from the address bar is the obvious move.
  const cleaned = raw
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = cleaned.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      ok: false,
      message: "Enter it as owner/repository, or paste the GitHub URL.",
    };
  }

  let outcome;
  try {
    outcome = await connectExistingRepo(ctx, db, {
      sitePublicId,
      owner: parts[0],
      name: parts[1],
      previewUrlStyle: style === "deploy_preview" ? "deploy_preview" : "pr_alias",
      netlifySiteName: netlifySiteName || undefined,
    });
  } catch (error) {
    console.error("[repo] connect threw", error);
    return {
      ok: false,
      message: `Could not connect it: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  revalidatePath(`/admin/clients`);

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: outcome.alreadyConnected
      ? `Reconnected ${parts[0]}/${parts[1]}. Details refreshed.`
      : `Connected ${parts[0]}/${parts[1]}. It is not yet allowed to receive automated work — turn that on below when you are ready.`,
  };
}

export async function setAllowlistAction(
  _previous: RepoActionResult | null,
  formData: FormData,
): Promise<RepoActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };
  const ctx = adminContextFrom(user);
  const db = await getDb();

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  const allow = String(formData.get("allowlisted") ?? "") === "true";

  const changed = await allowlistRepository(db, ctx.userId, sitePublicId, allow);
  revalidatePath(`/admin/clients`);

  if (!changed) {
    return { ok: false, message: "No connected repository to change." };
  }

  if (!allow) {
    return {
      ok: true,
      message: "Automated work is switched off. Nothing already in flight is cancelled.",
    };
  }

  // Allowing work is when the repository needs the credentials and the workflow
  // to do it. Without them a request opens an issue that nothing acts on, after
  // the portal has already told the client the change is under way.
  const installed = await installForAutomation(db, ctx.userId, sitePublicId);

  return {
    ok: installed.ok,
    message: `Automated work is allowed on this repository. ${installed.message}`,
  };
}

/**
 * The tokens and the agent workflow, each reported on its own.
 *
 * Attempted independently: a token that cannot be written is no reason not to
 * install the workflow, and the operator needs to know which half failed.
 */
async function installForAutomation(
  db: Database,
  actorUserId: string,
  sitePublicId: string,
): Promise<RepoActionResult> {
  const retry = "Use “Install tokens and agent workflow” to retry.";

  let tokens: RepoActionResult;
  try {
    tokens = describeTokenInstall(await installRepoTokens(db, actorUserId, sitePublicId));
  } catch (error) {
    console.error("[repo] token install threw", error);
    tokens = { ok: false, message: `Could not reach GitHub to install the tokens. ${retry}` };
  }

  let workflow: RepoActionResult;
  try {
    workflow = describeWorkflowInstall(await installAgentWorkflow(db, actorUserId, sitePublicId));
  } catch (error) {
    console.error("[repo] agent workflow install threw", error);
    workflow = {
      ok: false,
      message: `Could not write the agent workflow — the GitHub App needs Workflows: read & write. ${retry}`,
    };
  }

  return {
    ok: tokens.ok && workflow.ok,
    message: `${tokens.message} ${workflow.message}`,
  };
}

/**
 * Copy the portal's tokens and the agent workflow into the site's repository
 * again.
 *
 * For after a token is replaced in the portal's environment — a Claude token
 * from `claude setup-token` lasts a year — and for a repository allowed before
 * the portal installed either on allowing.
 */
export async function installTokensAction(
  _previous: RepoActionResult | null,
  formData: FormData,
): Promise<RepoActionResult> {
  const user = await requireAdmin();
  if (!user) return { ok: false, message: "Only an admin can do that." };
  const ctx = adminContextFrom(user);
  const db = await getDb();

  const sitePublicId = String(formData.get("sitePublicId") ?? "").trim();
  if (!sitePublicId) return { ok: false, message: "No site specified." };

  return installForAutomation(db, ctx.userId, sitePublicId);
}
