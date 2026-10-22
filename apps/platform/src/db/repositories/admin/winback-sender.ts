import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  winbackCampaigns,
  winbackContacts,
  winbackRecipients,
  winbackSuppressions,
} from "@/db/schema";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { newPublicId } from "@/lib/ids";
import { hasFeature } from "@/lib/growth/access";
import { keepSchedulerAwake } from "@/lib/scheduler/gate";
import { buildWinbackEmail } from "@/lib/winback/email";
import { winbackSenderAddress } from "@/lib/winback/readiness";
import { signUnsubscribeToken, unsubscribeUrls } from "@/lib/winback/unsubscribe-token";
import { getClientGrowth } from "./growth";
import { systemActor } from "./system-actor";

/**
 * Sending approved win-back campaigns, a batch per scheduler tick.
 *
 * ## One email per customer per campaign
 *
 * Each recipient row is claimed (`pending` → `sending`) by a conditional
 * update before its email goes, so two overlapping runs cannot both send it,
 * and settled afterwards. A run that dies between Resend accepting an email
 * and the row being settled leaves it `sending`; after `STALE_CLAIM_MS` it is
 * reclaimed and sent again with the **same** Resend idempotency key, which
 * Resend answers with the first email instead of a second. The unique
 * (campaign, email) index means a customer is only ever one row.
 *
 * ## Rate limits
 *
 * Resend allows a few requests a second per account, shared with every other
 * email the portal sends. Sends are spaced `intervalMs` apart (600 ms by
 * default, about 1.7 a second) and stop at `budgetMs`, so one tick never
 * crowds out a password reset or starves the cron endpoint's other jobs. A
 * 429 puts the row back and ends the run; the next tick carries on. While
 * anything is left, the scheduler is kept awake so the next tick comes in
 * minutes rather than at the six-hourly sweep.
 *
 * ## The kill switch
 *
 * The campaign's status is read again before every email. An operator's
 * halt, or the client's cancel, stops a batch already in progress after the
 * email in flight — not at the end of the batch.
 */

/** A claim older than this belongs to a run that died; the idempotency key makes resending it safe. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
/** Tries per recipient, counting rate-limited ones, before it is marked failed. */
const MAX_ATTEMPTS = 6;
/** Campaigns looked at per run, oldest approval first. */
const CAMPAIGNS_PER_RUN = 10;
const INSERT_CHUNK = 500;

export interface SendRunOptions {
  send?: (message: EmailMessage) => Promise<SendResult>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Stop starting new sends after this long. */
  budgetMs?: number;
  intervalMs?: number;
  env?: Record<string, string | undefined>;
}

export interface SendRunResult {
  campaigns: number;
  sent: number;
  notSent: number;
  suppressed: number;
  failed: number;
  /** Put back for a later run: a transient failure. */
  retrying: number;
  rateLimited: boolean;
  /** Campaigns that finished this run. */
  finished: number;
  /** Campaigns held because the client no longer has win-back. */
  held: number;
  /** Why nothing could be sent at all, when that is the case. */
  blocked: string | null;
}

function defaultInterval(env: Record<string, string | undefined>): number {
  const configured = Number(env.WINBACK_SEND_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 600;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Campaign = typeof winbackCampaigns.$inferSelect;

async function stillHasWinback(db: Database, organizationId: string): Promise<boolean> {
  const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.organizationId, organizationId)).limit(1);
  const actor = await systemActor(db);
  if (!client || !actor) return false;
  return hasFeature((await getClientGrowth(actor, db, client.publicId)).access, "winback");
}

/**
 * Address the campaign to everyone on the list as it starts sending.
 *
 * At the start rather than at approval, so a customer added between approving
 * and the scheduled day is included, and idempotent (unique on campaign and
 * email), so a run that dies here simply does it again. Suppressed customers
 * get a row too, marked at send time, so the results can say how many were
 * skipped rather than silently showing a smaller list.
 */
async function startSending(db: Database, campaign: Campaign, now: Date): Promise<void> {
  const contacts = await db
    .select({ id: winbackContacts.id, email: winbackContacts.email, name: winbackContacts.name })
    .from(winbackContacts)
    .where(eq(winbackContacts.organizationId, campaign.organizationId));
  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    await db
      .insert(winbackRecipients)
      .values(
        contacts.slice(i, i + INSERT_CHUNK).map((c) => ({
          publicId: newPublicId(),
          campaignId: campaign.id,
          organizationId: campaign.organizationId,
          contactId: c.id,
          email: c.email,
          name: c.name,
        })),
      )
      .onConflictDoNothing();
  }
  await db
    .update(winbackCampaigns)
    .set({ status: "sending", sendStartedAt: now, updatedAt: now })
    .where(and(eq(winbackCampaigns.id, campaign.id), eq(winbackCampaigns.status, "approved")));
}

async function currentStatus(db: Database, campaignId: string): Promise<string | null> {
  const [row] = await db.select({ status: winbackCampaigns.status }).from(winbackCampaigns).where(eq(winbackCampaigns.id, campaignId)).limit(1);
  return row?.status ?? null;
}

async function claimNext(db: Database, campaignId: string, now: Date) {
  for (let tries = 0; tries < 3; tries += 1) {
    const [next] = await db
      .select({ id: winbackRecipients.id })
      .from(winbackRecipients)
      .where(and(eq(winbackRecipients.campaignId, campaignId), eq(winbackRecipients.status, "pending")))
      .orderBy(asc(winbackRecipients.createdAt), asc(winbackRecipients.id))
      .limit(1);
    if (!next) return null;
    const [claimed] = await db
      .update(winbackRecipients)
      .set({ status: "sending", claimedAt: now, attempts: sql`${winbackRecipients.attempts} + 1`, updatedAt: now })
      .where(and(eq(winbackRecipients.id, next.id), eq(winbackRecipients.status, "pending")))
      .returning();
    if (claimed) return claimed;
    // Another run took it; look again.
  }
  return null;
}

async function settle(db: Database, id: string, patch: Partial<typeof winbackRecipients.$inferInsert>, now: Date) {
  await db.update(winbackRecipients).set({ ...patch, updatedAt: now }).where(eq(winbackRecipients.id, id));
}

async function finishIfDone(db: Database, campaignId: string, now: Date): Promise<boolean> {
  const [left] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(winbackRecipients)
    .where(and(eq(winbackRecipients.campaignId, campaignId), inArray(winbackRecipients.status, ["pending", "sending"])));
  if ((left?.n ?? 0) > 0) return false;
  const done = await db
    .update(winbackCampaigns)
    .set({ status: "sent", sentAt: now, updatedAt: now })
    .where(and(eq(winbackCampaigns.id, campaignId), eq(winbackCampaigns.status, "sending")))
    .returning({ id: winbackCampaigns.id });
  return done.length > 0;
}

export async function runWinbackSends(db: Database, options: SendRunOptions = {}): Promise<SendRunResult> {
  const send = options.send ?? sendEmail;
  const clock = options.now ?? (() => new Date());
  const sleep = options.sleep ?? wait;
  const env = options.env ?? process.env;
  const interval = options.intervalMs ?? defaultInterval(env);
  const budgetMs = options.budgetMs ?? 20_000;
  const started = Date.now();
  const result: SendRunResult = {
    campaigns: 0,
    sent: 0,
    notSent: 0,
    suppressed: 0,
    failed: 0,
    retrying: 0,
    rateLimited: false,
    finished: 0,
    held: 0,
    blocked: null,
  };

  const now = clock();
  const due = await db
    .select()
    .from(winbackCampaigns)
    .where(
      and(
        inArray(winbackCampaigns.status, ["approved", "sending"]),
        or(isNull(winbackCampaigns.scheduledFor), lte(winbackCampaigns.scheduledFor, now)),
      ),
    )
    .orderBy(asc(winbackCampaigns.approvedAt))
    .limit(CAMPAIGNS_PER_RUN);
  if (due.length === 0) return result;

  const senderAddress = winbackSenderAddress(env);
  const origin = (env.AUTH_URL ?? env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  if (!senderAddress || !origin) {
    // Approval refuses without these, so this is a server that lost its
    // configuration. Leave everything as it is for when it comes back.
    result.blocked = "No sending address or portal address is configured.";
    return result;
  }

  let sentThisRun = 0;
  campaigns: for (const campaign of due) {
    if (!(await stillHasWinback(db, campaign.organizationId))) {
      result.held += 1;
      continue;
    }
    if (!campaign.fromName || !campaign.replyTo || !campaign.postalAddress) {
      // Approval records all three. Without them there is no lawful email to send.
      result.held += 1;
      continue;
    }
    result.campaigns += 1;
    if (campaign.status === "approved") await startSending(db, campaign, clock());

    await db
      .update(winbackRecipients)
      .set({ status: "pending", updatedAt: clock() })
      .where(
        and(
          eq(winbackRecipients.campaignId, campaign.id),
          eq(winbackRecipients.status, "sending"),
          lt(winbackRecipients.claimedAt, new Date(clock().getTime() - STALE_CLAIM_MS)),
        ),
      );

    while (Date.now() - started < budgetMs) {
      if ((await currentStatus(db, campaign.id)) !== "sending") continue campaigns;
      const recipient = await claimNext(db, campaign.id, clock());
      if (!recipient) break;

      const [suppressed] = await db
        .select({ id: winbackSuppressions.id })
        .from(winbackSuppressions)
        .where(and(eq(winbackSuppressions.organizationId, campaign.organizationId), eq(winbackSuppressions.email, recipient.email)))
        .limit(1);
      if (suppressed) {
        await settle(db, recipient.id, { status: "suppressed" }, clock());
        result.suppressed += 1;
        continue;
      }

      const token = await signUnsubscribeToken(recipient.publicId);
      if (!token) {
        await settle(db, recipient.id, { status: "pending" }, clock());
        result.blocked = "AUTH_SECRET is not set, so unsubscribe links cannot be signed.";
        break campaigns;
      }
      const urls = unsubscribeUrls(origin, token);

      if (sentThisRun > 0 && interval > 0) await sleep(interval);
      sentThisRun += 1;
      const outcome = await send(
        buildWinbackEmail({
          campaign: {
            subject: campaign.subject,
            body: campaign.body,
            offer: campaign.offer,
            offerExpiresOn: campaign.offerExpiresOn,
            fromName: campaign.fromName,
            replyTo: campaign.replyTo,
            postalAddress: campaign.postalAddress,
          },
          recipient: { publicId: recipient.publicId, email: recipient.email, name: recipient.name },
          organizationId: campaign.organizationId,
          senderAddress,
          unsubscribeUrl: urls.page,
          oneClickUrl: urls.oneClick,
        }),
      );
      const at = clock();

      if (outcome.status === "sent") {
        await settle(db, recipient.id, { status: "sent", providerMessageId: outcome.id, sentAt: at, error: null }, at);
        result.sent += 1;
        continue;
      }
      if (outcome.status === "skipped") {
        await settle(db, recipient.id, { status: "not_sent", error: "No mail provider configured." }, at);
        result.notSent += 1;
        continue;
      }

      const error = outcome.error.slice(0, 500);
      const permanent = outcome.httpStatus !== undefined && outcome.httpStatus >= 400 && outcome.httpStatus < 500 && outcome.httpStatus !== 429;
      if (permanent || recipient.attempts >= MAX_ATTEMPTS) {
        await settle(db, recipient.id, { status: "failed", error }, at);
        result.failed += 1;
        continue;
      }
      await settle(db, recipient.id, { status: "pending", error }, at);
      result.retrying += 1;
      if (outcome.httpStatus === 429) {
        result.rateLimited = true;
        break campaigns;
      }
    }

    if (await finishIfDone(db, campaign.id, clock())) result.finished += 1;
  }

  // Work left over: keep the ticks coming rather than waiting for the sweep.
  if (result.campaigns > result.finished) await keepSchedulerAwake("win-back emails sending");
  return result;
}
