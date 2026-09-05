import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
import { tenantContextFrom, type SessionLike } from "@/db/repositories/context";
import {
  addRequestNote,
  listRequestTimelines,
} from "@/db/repositories/client/change-requests";
import { clientSummaryFromPullRequest } from "@/db/repositories/admin/webhooks";
import { notifyClientOfRequest } from "@/lib/notify/request";
import {
  buildChangeLiveEmail,
  buildPreviewReadyEmail,
} from "@/lib/email/request-updates";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The loop closing itself: the client is told what happened, exactly once,
 * and can see the story and add to it.
 *
 * What these protect:
 *  - a verified preview produces one email even though two code paths can
 *    verify it (webhook, then the five-minute re-check);
 *  - a preview email is never sent for an unverified URL;
 *  - the note a client adds lands on their own request only, and never on a
 *    request that is finished;
 *  - the agent's pull request body reaches the client stripped of markers.
 */

let db: Database;
let close: () => Promise<void>;

const sent: { to: string; subject: string }[] = [];

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string }) => {
    sent.push({ to: message.to, subject: message.subject });
    return { status: "sent", id: `msg_${sent.length}` };
  },
}));

let orgId: string;
let userId: string;
let siteId: string;

function session(): SessionLike {
  return { userId, organizationId: orgId, role: "client", status: "active", sessionEpoch: 0 };
}

async function seedRequest(status = "pr_open") {
  const request = (
    await db
      .insert(changeRequests)
      .values({
        publicId: newPublicId(),
        organizationId: orgId,
        siteId,
        title: "Swap the hero photo",
        status: status as never,
        category: "other",
        priority: "normal",
        createdByUserId: userId,
      })
      .returning()
  )[0]!;
  return request;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  sent.length = 0;
  await db.delete(requestEvents);
  await db.delete(agentJobs);
  await db.delete(changeRequests);
  await db.delete(organizationMemberships);
  await db.delete(clients);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);

  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Northwind", slug: "northwind", kind: "client" })
      .returning()
  )[0]!;
  orgId = org.id;

  const user = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "owner@northwind.test", name: "Dana", role: "client", status: "active" })
      .returning()
  )[0]!;
  userId = user.id;
  await db.insert(organizationMemberships).values({ organizationId: orgId, userId, role: "owner" as never });
  await db.insert(clients).values({ publicId: newPublicId(), organizationId: orgId, primaryContactEmail: "contact@northwind.test" });

  const site = (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: orgId, name: "Northwind", status: "live", primaryDomain: "northwind.example" })
      .returning()
  )[0]!;
  siteId = site.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyClientOfRequest", () => {
  it("emails the portal user once for a verified preview, and not again", async () => {
    const request = await seedRequest();
    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: request.id,
      status: "pr_open",
      previewUrl: "https://pr-4--northwind.netlify.app",
      previewVerifiedAt: new Date(),
    } as never);

    const first = await notifyClientOfRequest(db, request.id, "preview_ready");
    expect(first).toEqual({ status: "sent", to: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@northwind.test");
    expect(sent[0]!.subject).toContain("Swap the hero photo");

    const second = await notifyClientOfRequest(db, request.id, "preview_ready");
    expect(second).toEqual({ status: "skipped", reason: "already_sent" });
    expect(sent).toHaveLength(1);

    const events = await db
      .select()
      .from(requestEvents)
      .where(eq(requestEvents.requestId, request.id));
    expect(events.filter((e) => e.kind === "notification_sent")).toHaveLength(1);
    expect(events[0]!.visibility).toBe("client_visible");
  });

  it("does not send a preview email when no preview has been verified", async () => {
    const request = await seedRequest();
    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: request.id,
      status: "pr_open",
      previewUrl: "https://pr-4--northwind.netlify.app",
      previewVerifiedAt: null,
    } as never);

    const outcome = await notifyClientOfRequest(db, request.id, "preview_ready");
    expect(outcome.status).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("falls back to the primary contact when no portal user exists", async () => {
    await db.delete(organizationMemberships);
    const request = await seedRequest("verified");
    const outcome = await notifyClientOfRequest(db, request.id, "change_live");
    expect(outcome).toEqual({ status: "sent", to: 1 });
    expect(sent[0]!.to).toBe("contact@northwind.test");
  });

  it("sends a different kind for the same request independently", async () => {
    const request = await seedRequest("needs_operator");
    expect((await notifyClientOfRequest(db, request.id, "person_handling")).status).toBe("sent");
    expect((await notifyClientOfRequest(db, request.id, "snag")).status).toBe("sent");
    expect(sent).toHaveLength(2);
  });
});

describe("timeline and notes", () => {
  it("returns only client-visible events for the tenant's own requests", async () => {
    const request = await seedRequest("in_progress");
    await db.insert(requestEvents).values([
      { requestId: request.id, actorType: "system", kind: "work_started", body: "Started", visibility: "client_visible" },
      { requestId: request.id, actorType: "system", kind: "pr_opened", body: "PR #4", visibility: "internal" },
    ]);

    const ctx = tenantContextFrom(session(), orgId);
    const timelines = await listRequestTimelines(db, ctx, [request.publicId]);
    const entries = timelines.get(request.publicId) ?? [];
    expect(entries.map((e) => e.kind)).toEqual(["work_started"]);
  });

  it("records a note on an open request and refuses one on a finished request", async () => {
    const ctx = tenantContextFrom(session(), orgId);
    const open = await seedRequest("in_progress");
    const done = await seedRequest("verified");

    const ok = await addRequestNote(db, ctx, open.publicId, "The price is $120, not $110.");
    expect(ok.ok).toBe(true);

    const refused = await addRequestNote(db, ctx, done.publicId, "One more thing");
    expect(refused.ok).toBe(false);

    const events = await db.select().from(requestEvents).where(eq(requestEvents.requestId, open.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("client_note");
    expect(events[0]!.actorUserId).toBe(userId);
  });

  it("never lets one tenant note another tenant's request", async () => {
    const request = await seedRequest("in_progress");
    const other = (
      await db
        .insert(organizations)
        .values({ publicId: newPublicId(), name: "Globex", slug: "globex", kind: "client" })
        .returning()
    )[0]!;
    const ctx = tenantContextFrom(
      { userId, organizationId: other.id, role: "client", status: "active", sessionEpoch: 0 },
      other.id,
    );
    await expect(addRequestNote(db, ctx, request.publicId, "hello there")).rejects.toThrow();
  });
});

describe("what the client is shown", () => {
  it("strips markers and headings from the agent's pull request body", () => {
    const body = [
      "<!-- agent-job:01HXYZ -->",
      "<!-- agent-escalation: nothing -->",
      "## What changed",
      "",
      "Replaced the hero photo with the one you named \"new\".",
      "",
      "",
      "",
      "### Files",
      "- src/index.html",
    ].join("\n");
    expect(clientSummaryFromPullRequest(body)).toBe(
      "What changed\n\nReplaced the hero photo with the one you named \"new\".\n\nFiles\n- src/index.html",
    );
    expect(clientSummaryFromPullRequest("<!-- agent-job:01HXYZ -->")).toBeNull();
    expect(clientSummaryFromPullRequest(null)).toBeNull();
  });

  it("writes emails with the request title in the subject and one link each", () => {
    const preview = buildPreviewReadyEmail({
      contactName: "Dana",
      businessName: "Northwind",
      requestTitle: "Swap the hero photo",
      portalUrl: "https://portal.example",
      previewUrl: "https://pr-4--northwind.netlify.app",
    });
    expect(preview.subject).toBe("Ready to look at: Swap the hero photo");
    expect(preview.text).toContain("https://pr-4--northwind.netlify.app");
    expect(preview.text).toContain("https://portal.example/dashboard/requests#awaiting-approval");
    expect(preview.text).not.toMatch(/pull request|deploy|merge/i);

    const live = buildChangeLiveEmail({
      contactName: null,
      businessName: "Northwind",
      requestTitle: "Swap the hero photo",
      portalUrl: "https://portal.example",
      siteUrl: "https://northwind.example",
    });
    expect(live.text).toContain("Hi there,");
    expect(live.html).toContain("https://northwind.example");
  });
});
