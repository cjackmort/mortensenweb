import { and, asc, count, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { businessProfiles, leadReplies, leads, organizations, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import {
  buildLeadReplyEmail,
  isEmailAddress,
  MAX_REPLY_LENGTH,
  REPLIES_PER_HOUR,
  replySenderAddress,
} from "@/lib/growth/lead-reply";
import { formatDateWithYear } from "@/lib/time";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Replies to leads, tenant-scoped. The email itself is built in
 * `lib/growth/lead-reply.ts`; this is the part that decides whether a reply
 * may go, sends it, and keeps the record.
 */

export interface LeadReply {
  publicId: string;
  body: string;
  replyTo: string;
  status: "sent" | "failed" | "not_sent";
  sentByName: string | null;
  createdAt: Date;
}

export async function listLeadReplies(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
): Promise<LeadReply[]> {
  const rows = await db
    .select({
      publicId: leadReplies.publicId,
      body: leadReplies.body,
      replyTo: leadReplies.replyTo,
      status: leadReplies.status,
      sentByName: users.name,
      sentByEmail: users.email,
      createdAt: leadReplies.createdAt,
    })
    .from(leadReplies)
    .innerJoin(leads, eq(leads.id, leadReplies.leadId))
    .leftJoin(users, eq(users.id, leadReplies.sentBy))
    .where(
      and(
        eq(leads.publicId, leadPublicId),
        eq(leadReplies.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .orderBy(asc(leadReplies.createdAt));

  return rows.map((row) => ({
    publicId: row.publicId,
    body: row.body,
    replyTo: row.replyTo,
    status: row.status as LeadReply["status"],
    sentByName: row.sentByName ?? row.sentByEmail ?? null,
    createdAt: row.createdAt,
  }));
}

/**
 * Who a reply is from and where answers go: the business's name and public
 * email from its profile, falling back to the organization's name and the
 * signed-in person's own address. The same rules the page uses to tell the
 * client, before they press send, where the customer's answer will land.
 */
export async function replyIdentity(
  db: Database,
  ctx: TenantContext,
): Promise<{ businessName: string; replyTo: string | null }> {
  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details })
    .from(organizations)
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const [me] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);

  const profileName = org?.details?.businessName?.trim();
  const profileEmail = org?.details?.email?.trim();

  return {
    businessName: profileName || org?.name || "Your enquiry",
    replyTo: isEmailAddress(profileEmail)
      ? profileEmail
      : isEmailAddress(me?.email)
        ? me.email
        : null,
  };
}

export type SendReplyResult =
  | { ok: true; status: "sent" | "not_sent" }
  | { ok: false; message: string };

/**
 * Send a reply to a lead's customer.
 *
 * Refusals come first and are worded for the client. The send is recorded
 * whatever happens to it — a failed reply that left no trace would let a
 * client believe a customer had been answered when they had not.
 *
 * A reply that went out moves a `new` lead to `contacted`. That is a fact the
 * portal witnessed, not a guess: they contacted the customer, here, just now.
 */
export async function sendLeadReply(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  rawBody: string,
  {
    send = sendEmail,
    now = new Date(),
  }: { send?: (message: EmailMessage) => Promise<SendResult>; now?: Date } = {},
): Promise<SendReplyResult> {
  assertMutable(ctx);

  const body = rawBody.replace(/\r\n?/g, "\n").trim();
  if (!body) return { ok: false, message: "Write a reply first." };
  if (body.length > MAX_REPLY_LENGTH) {
    return { ok: false, message: `Keep replies under ${MAX_REPLY_LENGTH} characters.` };
  }

  const [lead] = await db
    .select({
      id: leads.id,
      email: leads.email,
      message: leads.message,
      status: leads.status,
      receivedAt: leads.receivedAt,
    })
    .from(leads)
    .where(
      and(
        eq(leads.publicId, leadPublicId),
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .limit(1);
  if (!lead) throw new NotFoundError();
  if (!isEmailAddress(lead.email)) {
    return { ok: false, message: "This enquiry has no email address to reply to." };
  }

  const [recent] = await db
    .select({ n: count() })
    .from(leadReplies)
    .where(
      and(
        eq(leadReplies.organizationId, ctx.organizationId),
        gte(leadReplies.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    );
  if ((recent?.n ?? 0) >= REPLIES_PER_HOUR) {
    return {
      ok: false,
      message: "That's a lot of replies in an hour. Please wait a little and try again.",
    };
  }

  const senderAddress = replySenderAddress();
  if (!senderAddress) {
    return { ok: false, message: "Replies aren't switched on yet. Please contact us." };
  }

  const identity = await replyIdentity(db, ctx);
  if (!identity.replyTo) {
    return {
      ok: false,
      message: "We need an email address for your business before replies can be sent. Please contact us.",
    };
  }

  const message = buildLeadReplyEmail({
    businessName: identity.businessName,
    senderAddress,
    replyTo: identity.replyTo,
    to: lead.email,
    body,
    original: { message: lead.message, receivedOn: formatDateWithYear(lead.receivedAt) },
  });

  const result = await send(message);
  const status = result.status === "sent" ? "sent" : result.status === "skipped" ? "not_sent" : "failed";

  await db.insert(leadReplies).values({
    publicId: newPublicId(),
    organizationId: ctx.organizationId,
    leadId: lead.id,
    sentBy: ctx.userId,
    body,
    replyTo: identity.replyTo,
    status,
    providerMessageId: result.status === "sent" ? result.id : null,
    error: result.status === "failed" ? result.error.slice(0, 500) : null,
    createdAt: now,
  });

  if (status === "failed") {
    return { ok: false, message: "Your reply could not be sent. Please try again in a minute." };
  }

  if (status === "sent" && lead.status === "new") {
    await db
      .update(leads)
      .set({ status: "contacted", statusChangedAt: now, updatedAt: now })
      .where(and(eq(leads.id, lead.id), eq(leads.status, "new")));
  }

  return { ok: true, status };
}
