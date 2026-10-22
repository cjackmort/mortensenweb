"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { disconnectGoogle, probeGoogleAccess } from "@/db/repositories/admin/google-connection";
import {
  acceptGoogleInvitation,
  addGooglePhoto,
  linkGoogleLocation,
  postReviewReply,
  publishGooglePost,
  redraftReply,
  resolveGoogleRequest,
  saveReplyDraft,
  syncGoogleClientNow,
  unlinkGoogleLocation,
  updateGoogleDescription,
  updateGoogleHours,
  updateGoogleSpecialHours,
  type EditResult,
} from "@/db/repositories/admin/google-edits";
import { parseHoursForm, parseSpecialHoursForm } from "@/lib/google-business/hours";

/**
 * The operator's Google actions. Each is a public POST endpoint like any
 * server action, so each re-checks for an active admin itself; the client
 * id in the form only ever names which client to act on.
 */

type Result = EditResult;

async function operator() {
  const user = await currentUser();
  if (!user || user.role !== "admin" || user.status !== "active") return null;
  return { ctx: adminContextFrom(user), db: await getDb() };
}

const SIGN_IN: Result = { ok: false, message: "Please sign in again." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function refresh(clientPublicId?: string) {
  revalidatePath("/admin/google");
  if (clientPublicId) revalidatePath(`/admin/google/${clientPublicId}`);
}

/** The repository's NotFoundError, said in the operator's terms. */
async function run(clientPublicId: string, fn: () => Promise<Result>): Promise<Result> {
  try {
    const result = await fn();
    refresh(clientPublicId);
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: error.message === "Not found" ? "That no longer exists." : error.message };
    }
    throw error;
  }
}

export async function checkAccessAction(): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const ok = await probeGoogleAccess(session.db);
  refresh();
  return ok
    ? { ok: true, message: "Google answered. The connection works." }
    : { ok: false, message: "Google still refused. The status above says why." };
}

export async function disconnectAction(): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const result = await disconnectGoogle(session.ctx, session.db);
  refresh();
  return result;
}

export async function acceptInvitationAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const result = await acceptGoogleInvitation(session.ctx, session.db, field(formData, "invitation"));
  refresh();
  return result;
}

export async function linkLocationAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const [accountName = "", locationName = ""] = field(formData, "location").split("|");
  return run(clientPublicId, () => linkGoogleLocation(session.ctx, session.db, clientPublicId, { accountName, locationName }));
}

export async function unlinkLocationAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  return run(clientPublicId, () => unlinkGoogleLocation(session.ctx, session.db, clientPublicId));
}

export async function syncNowAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  return run(clientPublicId, () => syncGoogleClientNow(session.ctx, session.db, clientPublicId));
}

export async function hoursAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const parsed = parseHoursForm(formData);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  return run(clientPublicId, () =>
    updateGoogleHours(session.ctx, session.db, clientPublicId, parsed.value, field(formData, "request") || null),
  );
}

export async function specialHoursAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const rows = Math.min(50, Math.max(0, Number.parseInt(field(formData, "rows"), 10) || 0));
  const parsed = parseSpecialHoursForm(formData, rows);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  return run(clientPublicId, () =>
    updateGoogleSpecialHours(session.ctx, session.db, clientPublicId, parsed.value, field(formData, "request") || null),
  );
}

export async function descriptionAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  return run(clientPublicId, () =>
    updateGoogleDescription(session.ctx, session.db, clientPublicId, field(formData, "description"), field(formData, "request") || null),
  );
}

export async function postAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const ctaType = field(formData, "ctaType");
  return run(clientPublicId, () =>
    publishGooglePost(session.ctx, session.db, clientPublicId, {
      summary: field(formData, "summary"),
      mediaAssetPublicId: field(formData, "photo") || null,
      cta: ctaType ? { type: ctaType, url: field(formData, "ctaUrl") || null } : null,
      requestPublicId: field(formData, "request") || null,
    }),
  );
}

export async function photoAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const photo = field(formData, "photo");
  if (!photo) return { ok: false, message: "Pick a photo." };
  return run(clientPublicId, () => addGooglePhoto(session.ctx, session.db, clientPublicId, photo));
}

export async function replyAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const review = field(formData, "review");
  const body = field(formData, "body");
  const intent = field(formData, "intent");
  return run(clientPublicId, () => {
    if (intent === "post") return postReviewReply(session.ctx, session.db, clientPublicId, review, body);
    if (intent === "redraft") return redraftReply(session.ctx, session.db, clientPublicId, review);
    return saveReplyDraft(session.ctx, session.db, clientPublicId, review, body);
  });
}

export async function resolveAskAction(_p: Result | null, formData: FormData): Promise<Result> {
  const session = await operator();
  if (!session) return SIGN_IN;
  const clientPublicId = field(formData, "client");
  const intent = field(formData, "intent");
  const status = intent === "declined" ? "declined" : intent === "open" ? "open" : "done";
  return run(clientPublicId, () =>
    resolveGoogleRequest(session.ctx, session.db, field(formData, "request"), { status, note: field(formData, "note") }),
  );
}
