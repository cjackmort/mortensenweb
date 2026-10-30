import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appointmentBookings, type AppointmentEmailStatus, type AppointmentStatus } from "@/db/schema";
import { buildCustomerEmail, type CustomerEmailKind } from "@/lib/availability/emails";
import { formatAppointment } from "@/lib/availability/format";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { replySenderAddress } from "@/lib/growth/lead-reply";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { replyIdentity } from "./lead-replies";

/**
 * Appointments booked on a client's website, and the client's decisions on
 * them: approve or decline a request, cancel a confirmed one.
 *
 * Every decision is one conditional UPDATE — it only applies from the state
 * it is a decision about — so two taps, or two people, decide once and email
 * once. The customer is emailed after, and what happened to that email is
 * stored and said back, so the page never claims someone was told when the
 * send failed.
 */

export interface AppointmentView {
  publicId: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  note: string | null;
  status: AppointmentStatus;
  decidedAt: Date | null;
  customerEmailStatus: AppointmentEmailStatus | null;
  createdAt: Date;
}

export interface AppointmentLists {
  /** Waiting for the client, soonest first. */
  pending: AppointmentView[];
  /** Confirmed and still to come, soonest first. */
  upcoming: AppointmentView[];
  /** Declined or cancelled lately, newest decision first: what was said no to. */
  recent: AppointmentView[];
}

const VIEW = {
  publicId: appointmentBookings.publicId,
  startsAt: appointmentBookings.startsAt,
  endsAt: appointmentBookings.endsAt,
  timeZone: appointmentBookings.timeZone,
  customerName: appointmentBookings.customerName,
  customerEmail: appointmentBookings.customerEmail,
  customerPhone: appointmentBookings.customerPhone,
  note: appointmentBookings.note,
  status: appointmentBookings.status,
  decidedAt: appointmentBookings.decidedAt,
  customerEmailStatus: appointmentBookings.customerEmailStatus,
  createdAt: appointmentBookings.createdAt,
};

const RECENT_LIMIT = 10;
const UPCOMING_LIMIT = 50;

export async function listAppointments(db: Database, ctx: TenantContext, now: Date = new Date()): Promise<AppointmentLists> {
  const mine = eq(appointmentBookings.organizationId, ctx.organizationId);
  const future = gt(appointmentBookings.startsAt, now);
  const [pending, upcoming, recent] = await Promise.all([
    db
      .select(VIEW)
      .from(appointmentBookings)
      .where(and(mine, future, eq(appointmentBookings.status, "pending")))
      .orderBy(asc(appointmentBookings.startsAt))
      .limit(UPCOMING_LIMIT),
    db
      .select(VIEW)
      .from(appointmentBookings)
      .where(and(mine, future, eq(appointmentBookings.status, "confirmed")))
      .orderBy(asc(appointmentBookings.startsAt))
      .limit(UPCOMING_LIMIT),
    db
      .select(VIEW)
      .from(appointmentBookings)
      .where(and(mine, future, inArray(appointmentBookings.status, ["declined", "cancelled"])))
      .orderBy(desc(appointmentBookings.decidedAt))
      .limit(RECENT_LIMIT),
  ]);
  return { pending, upcoming, recent };
}

export type Decision = "approve" | "decline" | "cancel";

const TRANSITION: Record<Decision, { from: AppointmentStatus; to: AppointmentStatus; email: CustomerEmailKind }> = {
  approve: { from: "pending", to: "confirmed", email: "confirmed" },
  decline: { from: "pending", to: "declined", email: "declined" },
  cancel: { from: "confirmed", to: "cancelled", email: "cancelled" },
};

export interface DecisionDeps {
  send?: (message: EmailMessage) => Promise<SendResult>;
  now?: Date;
}

export type DecisionResult = { ok: true; message: string } | { ok: false; message: string };

async function emailCustomer(
  db: Database,
  ctx: TenantContext,
  booking: { publicId: string; customerEmail: string; customerName: string; startsAt: Date; timeZone: string },
  kind: CustomerEmailKind,
  deps: DecisionDeps,
): Promise<{ status: AppointmentEmailStatus; error: string | null }> {
  const senderAddress = replySenderAddress();
  const identity = await replyIdentity(db, ctx);
  if (!senderAddress || !identity.replyTo) return { status: "not_sent", error: null };
  const message = buildCustomerEmail({
    kind,
    businessName: identity.businessName,
    senderAddress,
    replyTo: identity.replyTo,
    to: booking.customerEmail,
    customerName: booking.customerName,
    start: booking.startsAt,
    timeZone: booking.timeZone,
    bookingId: booking.publicId,
  });
  try {
    const result = await (deps.send ?? sendEmail)(message);
    if (result.status === "sent") return { status: "sent", error: null };
    if (result.status === "skipped") return { status: "not_sent", error: null };
    return { status: "failed", error: result.error.slice(0, 500) };
  } catch (error) {
    return { status: "failed", error: (error instanceof Error ? error.message : "unknown").slice(0, 500) };
  }
}

const DONE: Record<Decision, string> = {
  approve: "Approved",
  decline: "Declined",
  cancel: "Cancelled",
};

/** What the customer was told, in one sentence for the page. */
function toldSentence(name: string, status: AppointmentEmailStatus, decision: Decision, phone: string | null): string {
  if (status === "sent") return `${name} was emailed.`;
  const call = phone ? ` Call them on ${phone}.` : " Reply to them from your own email.";
  if (status === "failed") return `The email to ${name} didn't go through.${call}`;
  return `${name} wasn't emailed (sending isn't set up yet).${decision === "approve" ? "" : call}`;
}

/**
 * Approve or decline a request, or cancel a confirmed booking. Past
 * appointments are left alone: there is nothing left to decide.
 */
export async function decideAppointment(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  decision: Decision,
  deps: DecisionDeps = {},
): Promise<DecisionResult> {
  assertMutable(ctx);
  const now = deps.now ?? new Date();
  const step = TRANSITION[decision];

  const [claimed] = await db
    .update(appointmentBookings)
    .set({ status: step.to, decidedBy: ctx.userId, decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(appointmentBookings.publicId, publicId),
        eq(appointmentBookings.organizationId, ctx.organizationId),
        eq(appointmentBookings.status, step.from),
        gt(appointmentBookings.startsAt, now),
      ),
    )
    .returning({
      id: appointmentBookings.id,
      publicId: appointmentBookings.publicId,
      customerName: appointmentBookings.customerName,
      customerEmail: appointmentBookings.customerEmail,
      customerPhone: appointmentBookings.customerPhone,
      startsAt: appointmentBookings.startsAt,
      timeZone: appointmentBookings.timeZone,
    });

  if (!claimed) {
    const [row] = await db
      .select({ status: appointmentBookings.status, startsAt: appointmentBookings.startsAt })
      .from(appointmentBookings)
      .where(and(eq(appointmentBookings.publicId, publicId), eq(appointmentBookings.organizationId, ctx.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError();
    if (row.startsAt.getTime() <= now.getTime()) return { ok: false, message: "That time has already passed." };
    return { ok: false, message: `That booking is already ${row.status}.` };
  }

  const email = await emailCustomer(db, ctx, claimed, step.email, deps);
  await db
    .update(appointmentBookings)
    .set({ customerEmailStatus: email.status, customerEmailError: email.error, updatedAt: now })
    .where(eq(appointmentBookings.id, claimed.id));

  const when = formatAppointment(claimed.startsAt, claimed.timeZone);
  const freed = decision === "approve" ? "" : " The time is open on your website again.";
  return {
    ok: true,
    message: `${DONE[decision]}: ${claimed.customerName}, ${when}. ${toldSentence(claimed.customerName, email.status, decision, claimed.customerPhone)}${freed}`,
  };
}
