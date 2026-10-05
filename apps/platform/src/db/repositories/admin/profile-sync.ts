import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { sites } from "@/db/schema";
import type { AdminContext } from "../context";
import { dispatchChangeRequest } from "./agent-jobs";
import { markProfileApplied, profileEntriesFor } from "./business-profile";
import { createInternalChangeRequest } from "./internal-requests";

/**
 * "Put it on the site": one change that brings a whole site in line with the
 * client's general information.
 *
 * An ordinary change request, so it travels the ordinary road — agent, preview,
 * the operator's check, the client's approval — and nothing about it reaches
 * the live site without both of those. The details themselves are attached to
 * the issue the same way they are to every run (`runDispatch`), so this
 * request only has to say what to do with them.
 *
 * Billed as a courtesy: getting a client's own details right is setup work,
 * not one of their monthly changes.
 */

const TITLE = "Update the site with the business's general information";

const DESCRIPTION = [
  "Bring the whole site in line with the business's general information, which",
  "is attached to this issue.",
  "",
  "- Header and footer: phone, email, address and opening hours.",
  "- Contact page: every contact detail, the hours, and the booking link if there is one.",
  "- Services: the list of services or products, with prices where they are given.",
  "- Areas served, wherever the site says where the business works.",
  "- Social and review links, wherever the site links out.",
  "- About: the description and the story, where the site has an about section.",
  "- Search: the LocalBusiness structured data and the page descriptions, built",
  "  only from these details.",
  "",
  "Replace any placeholder these details now answer, and correct anything that",
  "contradicts them. Do not add anything that is not listed, and leave alone the",
  "parts of the site these details do not cover.",
].join("\n");

export type ProfileSyncOutcome =
  | { ok: true; message: string; issueUrl: string }
  | { ok: false; message: string };

export async function sendProfileToSite(
  ctx: AdminContext,
  db: Database,
  input: { organizationId: string; sitePublicId: string },
): Promise<ProfileSyncOutcome> {
  if ((await profileEntriesFor(db, input.organizationId)).length === 0) {
    return { ok: false, message: "Fill in the general information first." };
  }

  // `createInternalChangeRequest` trusts the site id it is given; this is the
  // one caller reached from a page about a particular client, so the site must
  // be that client's.
  const owned = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.publicId, input.sitePublicId), eq(sites.organizationId, input.organizationId)))
    .limit(1);
  if (!owned[0]) return { ok: false, message: "That site does not belong to this client." };

  const created = await createInternalChangeRequest(ctx, db, {
    organizationId: input.organizationId,
    sitePublicId: input.sitePublicId,
    title: TITLE,
    description: DESCRIPTION,
    category: "content",
  });
  if (!created.ok) return { ok: false, message: created.message };

  const dispatched = await dispatchChangeRequest(ctx, db, { requestPublicId: created.publicId });
  if (!dispatched.ok) {
    return {
      ok: false,
      message: `The change is in the queue but the agent did not start: ${dispatched.message} Start it from Requests once that is fixed.`,
    };
  }

  await markProfileApplied(db, input.organizationId);

  return {
    ok: true,
    issueUrl: dispatched.issueUrl,
    message: `Sent to the agent (issue #${dispatched.issueNumber}). The preview comes to Requests for you to check before the client sees it.`,
  };
}
