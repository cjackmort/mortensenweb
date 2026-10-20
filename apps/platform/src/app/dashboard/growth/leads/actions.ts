"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb, type Database } from "@/db/client";
import { NotFoundError, tenantContextFrom, type TenantContext } from "@/db/repositories/context";
import { deleteLead, isLeadStatus, isLeadView, setLeadStatus } from "@/db/repositories/client/leads";
import { sendLeadReply } from "@/db/repositories/client/lead-replies";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import {
  approveBooking,
  declineBooking,
  holdBooking,
  setBookingListed,
  type BookingResult,
} from "@/db/repositories/client/event-bookings";

/**
 * Lead mutations. Both re-derive the tenant from the session: a server action
 * is a public POST endpoint, and the public id in the form is only ever looked
 * up inside the caller's own organization.
 */

export type LeadActionResult = { ok: true; message: string } | { ok: false; message: string };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  return { ctx: tenantContextFrom(user, user.organizationId), db: await getDb() };
}

function refresh(publicId: string) {
  // "layout" so the unread count on the Growth tab is recomputed too.
  revalidatePath("/dashboard", "layout");
  revalidatePath(`/dashboard/growth/leads/${publicId}`);
}

const STATUS_SAVED: Record<string, string> = {
  new: "Marked as new.",
  contacted: "Marked as contacted.",
  won: "Marked as won — nice.",
  lost: "Marked as lost.",
  archived: "Archived. It stays under Archived if you need it.",
};

export async function setLeadStatusAction(
  _previous: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const publicId = String(formData.get("lead") ?? "");
  const status = formData.get("status");
  if (!isLeadStatus(status)) return { ok: false, message: "Pick a status." };

  try {
    await setLeadStatus(session.db, session.ctx, publicId, status);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That enquiry no longer exists." };
    }
    throw error;
  }

  refresh(publicId);
  return { ok: true, message: STATUS_SAVED[status] ?? "Saved." };
}

export async function deleteLeadAction(formData: FormData): Promise<void> {
  const session = await context();
  if (!session) redirect("/login");

  const publicId = String(formData.get("lead") ?? "");
  try {
    await deleteLead(session.db, session.ctx, publicId);
  } catch (error) {
    // Already gone is the outcome they asked for.
    if (!(error instanceof NotFoundError)) throw error;
  }

  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/growth/leads?deleted=1");
}

export async function sendLeadReplyAction(
  _previous: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  const publicId = String(formData.get("lead") ?? "");
  const body = String(formData.get("body") ?? "");

  // The page is gated, and so is the one action here that reaches the
  // outside world: a reply is an email sent in the business's name.
  if (!(await requireGrowthFeature(session.db, session.ctx, "leads"))) {
    return { ok: false, message: "Your plan does not include the leads inbox. See Growth to add it." };
  }

  let result;
  try {
    result = await sendLeadReply(session.db, session.ctx, publicId, body);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That enquiry no longer exists." };
    }
    throw error;
  }
  if (!result.ok) return result;

  refresh(publicId);
  return {
    ok: true,
    message:
      result.status === "sent"
        ? "Sent. Their answer will come to your email."
        : "Saved, but not emailed — sending isn't set up on this server.",
  };
}

// ---------------------------------------------------------------------------
// Booking requests
// ---------------------------------------------------------------------------

const BOOKING_OPS = ["hold", "approve", "decline", "unlist", "relist"] as const;
type BookingOp = (typeof BOOKING_OPS)[number];

function isBookingOp(value: unknown): value is BookingOp {
  return typeof value === "string" && (BOOKING_OPS as readonly string[]).includes(value);
}

async function runBookingOp(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  op: BookingOp,
  formData: FormData,
): Promise<BookingResult> {
  const when = { eventDate: formData.get("date"), startTime: formData.get("time") };
  if (op === "hold") return holdBooking(db, ctx, publicId, when);
  if (op === "approve") return approveBooking(db, ctx, publicId, when);
  if (op === "decline") return declineBooking(db, ctx, publicId);
  return setBookingListed(db, ctx, publicId, op === "relist");
}

/**
 * Save to calendar, approve, decline, take off the site, put back — one
 * action, chosen by the button pressed, so the panel holds one result that
 * survives the panel redrawing itself into its new state.
 *
 * Gated like replies: approving emails someone in the business's name, and
 * every one of these changes what the client's website shows.
 */
export async function bookingAction(
  _previous: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };
  if (!(await requireGrowthFeature(session.db, session.ctx, "leads"))) {
    return { ok: false, message: "Your plan does not include the leads inbox. See Growth to add it." };
  }

  const publicId = String(formData.get("lead") ?? "");
  const op = formData.get("op");
  if (!isBookingOp(op)) return { ok: false, message: "Pick approve or decline." };

  const { db, ctx } = session;
  let result: BookingResult;
  try {
    result = await runBookingOp(db, ctx, publicId, op, formData);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That request no longer exists." };
    }
    throw error;
  }

  if (!result.ok) return result;
  refresh(publicId);

  // From the inbox list, the row's buttons give way to its new state as soon
  // as the list redraws, and this result would go with them. The list says
  // what happened instead.
  const inboxView = formData.get("inbox");
  if (isLeadView(inboxView)) {
    const view = inboxView === "open" ? "" : `view=${inboxView}&`;
    redirect(`/dashboard/growth/leads?${view}decided=${encodeURIComponent(publicId)}`);
  }
  return result;
}
