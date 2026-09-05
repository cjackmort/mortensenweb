import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  clients,
  organizationMemberships,
  organizations,
  requestEvents,
  sites,
  users,
} from "@/db/schema";
import { sendEmail } from "@/lib/email/mailer";
import {
  buildChangeLiveEmail,
  buildPersonHandlingEmail,
  buildPreviewReadyEmail,
  buildSnagEmail,
} from "@/lib/email/request-updates";

/**
 * Tell the client what just happened to their request.
 *
 * Called from the places that move a request between stages — the preview
 * verifier, the shipped-change checker, the escalation handler, the watchdog.
 * It is deliberately a separate step after the state change rather than part
 * of it: a mail provider outage must never roll back a verified preview, so
 * every failure here is caught, recorded, and reported as a result the caller
 * can log.
 *
 * ## Exactly once
 *
 * Two code paths can verify the same preview (the deploy webhook and the
 * five-minute re-check), and the watchdog runs every tick. Each send is
 * recorded as a `notification_sent` event keyed by kind, and a second call
 * for the same request and kind is a no-op. That check is what lets the
 * callers stay simple.
 *
 * ## Who is told
 *
 * The client's portal users — the people who can act on the message — with
 * the organisation's primary contact as the fallback for a client whose
 * portal account has not been issued yet. Addresses are read at send time,
 * never stored on the event.
 */

export type RequestNotification =
  | "preview_ready"
  | "change_live"
  | "person_handling"
  | "snag";

export type NotifyOutcome =
  | { status: "sent"; to: number }
  | { status: "skipped"; reason: "already_sent" | "no_recipient" | "no_request" | "no_api_key" }
  | { status: "failed"; error: string };

export async function notifyClientOfRequest(
  db: Database,
  requestId: string,
  kind: RequestNotification,
): Promise<NotifyOutcome> {
  try {
    const already = await db
      .select({ id: requestEvents.id })
      .from(requestEvents)
      .where(
        and(
          eq(requestEvents.requestId, requestId),
          eq(requestEvents.kind, "notification_sent"),
          sql`${requestEvents.metadata} ->> 'notification' = ${kind}`,
        ),
      )
      .limit(1);
    if (already.length > 0) return { status: "skipped", reason: "already_sent" };

    const rows = await db
      .select({
        title: changeRequests.title,
        organizationId: changeRequests.organizationId,
        businessName: organizations.name,
        contactName: clients.primaryContactName,
        contactEmail: clients.primaryContactEmail,
        siteDomain: sites.primaryDomain,
        siteUrl: sites.productionUrl,
      })
      .from(changeRequests)
      .leftJoin(organizations, eq(organizations.id, changeRequests.organizationId))
      .leftJoin(clients, eq(clients.organizationId, changeRequests.organizationId))
      .leftJoin(sites, eq(sites.id, changeRequests.siteId))
      .where(eq(changeRequests.id, requestId))
      .limit(1);

    const request = rows[0];
    if (!request) return { status: "skipped", reason: "no_request" };

    // The verified preview of the latest job, if any. Verified only: the
    // email must never send a client to a URL that has not been fetched.
    const previewRows = await db
      .select({ previewUrl: agentJobs.previewUrl })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.requestId, requestId),
          sql`${agentJobs.previewVerifiedAt} is not null`,
        ),
      )
      .orderBy(sql`${agentJobs.createdAt} desc`)
      .limit(1);
    const previewUrl = previewRows[0]?.previewUrl ?? null;

    const members = await db
      .select({ email: users.email, name: users.name })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(
        and(
          eq(organizationMemberships.organizationId, request.organizationId),
          eq(users.role, "client"),
          eq(users.status, "active"),
        ),
      );

    const recipients = members.length
      ? members.map((m) => ({ email: m.email, name: m.name }))
      : request.contactEmail
        ? [{ email: request.contactEmail, name: request.contactName }]
        : [];

    if (recipients.length === 0) {
      return { status: "skipped", reason: "no_recipient" };
    }

    const portalUrl = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
    const siteUrl = request.siteDomain
      ? `https://${request.siteDomain}`
      : (request.siteUrl ?? null);

    let sentCount = 0;
    let lastError: string | null = null;
    let skippedForKey = false;

    for (const recipient of recipients) {
      const base = {
        contactName: recipient.name ?? request.contactName,
        businessName: request.businessName ?? "your business",
        requestTitle: request.title,
        portalUrl,
      };

      const message =
        kind === "preview_ready"
          ? previewUrl
            ? buildPreviewReadyEmail({ ...base, previewUrl })
            : null
          : kind === "change_live"
            ? buildChangeLiveEmail({ ...base, siteUrl })
            : kind === "person_handling"
              ? buildPersonHandlingEmail(base)
              : buildSnagEmail(base);

      if (!message) return { status: "skipped", reason: "no_request" };

      const result = await sendEmail({ ...message, to: recipient.email });
      if (result.status === "sent") sentCount += 1;
      else if (result.status === "skipped") skippedForKey = true;
      else lastError = result.error;
    }

    if (sentCount === 0 && skippedForKey) {
      // Development: logged to the console, never marked as sent — so the
      // first deploy with a real key sends the message for real.
      return { status: "skipped", reason: "no_api_key" };
    }

    if (sentCount === 0 && lastError) {
      await db.insert(requestEvents).values({
        requestId,
        actorType: "system",
        kind: "notification_failed",
        body: `Could not email the client about "${kind}": ${lastError}`,
        visibility: "internal",
        metadata: { notification: kind },
      });
      return { status: "failed", error: lastError };
    }

    await db.insert(requestEvents).values({
      requestId,
      actorType: "system",
      kind: "notification_sent",
      body: describe(kind),
      visibility: "client_visible",
      metadata: { notification: kind, recipients: sentCount },
    });

    return { status: "sent", to: sentCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[notify] request notification failed", { requestId, kind, message });
    return { status: "failed", error: message };
  }
}

/** The line the timeline shows for the send itself. */
function describe(kind: RequestNotification): string {
  switch (kind) {
    case "preview_ready":
      return "We emailed you that the preview is ready.";
    case "change_live":
      return "We emailed you that it's live.";
    case "person_handling":
      return "We emailed you that a person is finishing this.";
    case "snag":
      return "We emailed you that this hit a snag.";
  }
}
