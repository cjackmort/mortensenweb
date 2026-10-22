import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, payments, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { onboardingSteps } from "@/lib/onboarding/status";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The operator's side of a new client, before they pay: the demo link, the
 * email asking for a call, and where the client has got to.
 *
 * Worth testing: an email recorded as sent that never went, a demo link that
 * is not a link, a status that says "paid" before any money arrived, and no
 * record of what was sent to whom.
 */

const outbox: Array<{ to: string; subject: string; text: string; html: string }> = [];
let sendStatus: "sent" | "skipped" | "failed" = "sent";

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string; html: string }) => {
    outbox.push(message);
    if (sendStatus === "sent") return { status: "sent", id: "email_1" };
    if (sendStatus === "skipped") return { status: "skipped", reason: "no_api_key" };
    return { status: "failed", error: "Resend responded 500" };
  },
}));

const onboarding = await import("@/db/repositories/admin/onboarding");

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let publicId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [operator] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", name: "Jordan", role: "admin", status: "active" })
    .returning();
  admin = adminContextFrom({ userId: operator!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  outbox.length = 0;
  sendStatus = "sent";
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  const [row] = await db
    .update(clients)
    .set({ primaryContactName: "Dana", primaryContactEmail: "dana@acme.test" })
    .where(eq(clients.id, acme.clientId))
    .returning({ publicId: clients.publicId });
  publicId = row!.publicId;
});

describe("onboardingSteps", () => {
  const none = { demoSentAt: null, loginSentAt: null, passwordSetAt: null, paidAt: null, domainAccessAt: null };

  it("starts at the demo", () => {
    expect(onboardingSteps(none).next).toBe("demo");
  });

  it("moves to the step after the furthest one done", () => {
    const at = new Date("2026-10-20T12:00:00Z");
    expect(onboardingSteps({ ...none, demoSentAt: at }).next).toBe("login");
    expect(onboardingSteps({ ...none, demoSentAt: at, loginSentAt: at }).next).toBe("password");
    expect(onboardingSteps({ ...none, demoSentAt: at, loginSentAt: at, passwordSetAt: at }).next).toBe("paid");
  });

  it("moves to the domain once paid, whatever came before", () => {
    const result = onboardingSteps({ ...none, paidAt: new Date() });
    expect(result.next).toBe("domain");
    expect(result.steps.map((s) => s.key)).toEqual(["demo", "login", "password", "paid", "domain"]);
  });

  it("does not send a client who was given a login without a demo back to the demo", () => {
    expect(onboardingSteps({ ...none, loginSentAt: new Date() }).next).toBe("password");
  });
});

describe("getOnboarding", () => {
  it("reads each step from what actually happened", async () => {
    const sent = new Date("2026-10-18T16:00:00Z");
    await db.update(clients).set({ demoUrl: "https://acme-demo.netlify.app", demoSentAt: sent }).where(eq(clients.id, acme.clientId));
    await db.update(users).set({ invitedAt: new Date("2026-10-19T16:00:00Z"), mustChangePassword: false, activatedAt: new Date("2026-10-20T16:00:00Z") }).where(eq(users.id, acme.userId));

    const view = await onboarding.getOnboarding(admin, db, publicId);

    expect(view?.steps.map((s) => [s.key, s.doneAt?.toISOString() ?? null])).toEqual([
      ["demo", "2026-10-18T16:00:00.000Z"],
      ["login", "2026-10-19T16:00:00.000Z"],
      ["password", "2026-10-20T16:00:00.000Z"],
      ["paid", null],
      ["domain", null],
    ]);
    expect(view?.next).toBe("paid");
  });

  it("counts a payment recorded before the cart existed as paid", async () => {
    await db.insert(payments).values({ publicId: newPublicId(), clientId: acme.clientId, amountCents: 25000, method: "venmo", receivedOn: "2026-09-01" });

    const view = await onboarding.getOnboarding(admin, db, publicId);

    expect(view?.steps.find((s) => s.key === "paid")?.doneAt).not.toBeNull();
    expect(view?.next).toBe("domain");
  });

  it("offers a draft email with the demo link and the operator's name", async () => {
    await db.update(clients).set({ demoUrl: "https://acme-demo.netlify.app" }).where(eq(clients.id, acme.clientId));

    const view = await onboarding.getOnboarding(admin, db, publicId);

    expect(view?.draft.to).toBe("dana@acme.test");
    expect(view?.draft.body).toContain("https://acme-demo.netlify.app");
    expect(view?.draft.body).toMatch(/^Hi Dana,/);
    expect(view?.draft.body).toContain("Jordan");
  });
});

describe("setDemoUrl", () => {
  it("saves an https link", async () => {
    const result = await onboarding.setDemoUrl(admin, db, { clientPublicId: publicId, demoUrl: " https://acme-demo.netlify.app/ " });
    expect(result.ok).toBe(true);
    const [row] = await db.select({ url: clients.demoUrl }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row!.url).toBe("https://acme-demo.netlify.app/");
  });

  it.each(["acme-demo.netlify.app", "javascript:alert(1)", "http://acme-demo.netlify.app", "ftp://x.test"])(
    "refuses %s",
    async (url) => {
      const result = await onboarding.setDemoUrl(admin, db, { clientPublicId: publicId, demoUrl: url });
      expect(result.ok).toBe(false);
    },
  );

  it("clears it when left empty", async () => {
    await onboarding.setDemoUrl(admin, db, { clientPublicId: publicId, demoUrl: "https://acme-demo.netlify.app" });
    await onboarding.setDemoUrl(admin, db, { clientPublicId: publicId, demoUrl: "" });
    const [row] = await db.select({ url: clients.demoUrl }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row!.url).toBeNull();
  });
});

describe("sendDemoInvite", () => {
  const draft = { to: "dana@acme.test", subject: "A new website for Acme", body: "Hi Dana,\n\nHave a look: https://acme-demo.netlify.app\n\nJordan" };

  beforeEach(async () => {
    await db.update(clients).set({ demoUrl: "https://acme-demo.netlify.app" }).where(eq(clients.id, acme.clientId));
  });

  it("sends the edited email, stamps when, and records what went to whom", async () => {
    const result = await onboarding.sendDemoInvite(admin, db, { clientPublicId: publicId, ...draft });

    expect(result).toMatchObject({ ok: true });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "dana@acme.test", subject: "A new website for Acme" });
    expect(outbox[0]!.html).toContain('<a href="https://acme-demo.netlify.app"');
    const [row] = await db.select({ at: clients.demoSentAt }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row!.at).not.toBeNull();
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "onboarding.demo_sent")).limit(1);
    expect(entry?.metadata).toMatchObject({ to: "dana@acme.test", subject: "A new website for Acme", status: "sent" });
  });

  it("does not mark the demo sent when email is not configured", async () => {
    sendStatus = "skipped";

    const result = await onboarding.sendDemoInvite(admin, db, { clientPublicId: publicId, ...draft });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/not sent/i) });
    const [row] = await db.select({ at: clients.demoSentAt }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row!.at).toBeNull();
  });

  it("does not mark it sent when the send fails", async () => {
    sendStatus = "failed";

    const result = await onboarding.sendDemoInvite(admin, db, { clientPublicId: publicId, ...draft });

    expect(result.ok).toBe(false);
    const [row] = await db.select({ at: clients.demoSentAt }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row!.at).toBeNull();
  });

  it("refuses without a demo link saved", async () => {
    await db.update(clients).set({ demoUrl: null }).where(eq(clients.id, acme.clientId));

    const result = await onboarding.sendDemoInvite(admin, db, { clientPublicId: publicId, ...draft });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/demo URL/) });
    expect(outbox).toEqual([]);
  });

  it.each([
    [{ to: "not-an-address" }, /email address/],
    [{ subject: "  " }, /subject/],
    [{ body: "" }, /message/],
  ])("refuses %o", async (change, message) => {
    const result = await onboarding.sendDemoInvite(admin, db, { clientPublicId: publicId, ...draft, ...change });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    expect(outbox).toEqual([]);
  });
});
