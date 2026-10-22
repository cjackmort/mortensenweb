import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  netlifySignatureFor,
  parseSubmission,
  siteHookSecret,
  verifyNetlifySignature,
} from "@/lib/growth/netlify-forms";
import { recordLead, type FormsSite } from "@/db/repositories/admin/leads";
import {
  countUnreadLeads,
  deleteLead,
  isLeadOutcome,
  listLeads,
  openLead,
  setLeadArchived,
  setLeadStatus,
} from "@/db/repositories/client/leads";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The leads inbox.
 *
 * Two things here would fail silently in production rather than loudly: a
 * delivery landing in the wrong client's inbox, and a deleted customer coming
 * back on the next import. Each has a test below that would catch it.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let acmeSite: FormsSite;
let globexSite: FormsSite;

const sent: Array<{ to: string; subject: string; html: string; replyTo?: string }> = [];

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; html: string; replyTo?: string }) => {
    sent.push(message);
    return { status: "sent", id: "test" };
  }),
}));

vi.mock("@/db/client", () => ({ getDb: async () => db }));

async function addSite(tenant: SeededTenant, name: string): Promise<FormsSite> {
  const rows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name,
      netlifySiteId: `netlify-${name}`,
    })
    .returning({
      id: sites.id,
      publicId: sites.publicId,
      organizationId: sites.organizationId,
      netlifySiteId: sites.netlifySiteId,
    });
  return rows[0]!;
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: newPublicId(),
    form_name: "contact",
    created_at: "2026-10-01T15:00:00.000Z",
    data: {
      name: "Dana Reyes",
      email: "dana@example.test",
      phone: "555-0100",
      message: "Water heater is leaking, can you come Thursday?",
      ip: "203.0.113.9",
      user_agent: "Mozilla/5.0",
      referrer: "https://acme.example/contact/",
      "bot-field": "",
    },
    ...overrides,
  };
}

async function record(site: FormsSite, payload = submission(), options = {}) {
  const parsed = parseSubmission(payload);
  if (!parsed.ok) throw new Error("fixture did not parse");
  return recordLead(db, site, parsed.lead, options);
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
  acmeSite = await addSite(acme, "acme");
  globexSite = await addSite(globex, "globex");
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  sent.length = 0;
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("Netlify's webhook signature", () => {
  const body = JSON.stringify(submission());

  it("accepts a genuine delivery", async () => {
    const token = await netlifySignatureFor(body, "secret");
    expect(await verifyNetlifySignature(body, token, "secret")).toBe(true);
  });

  it("refuses a genuine token attached to a different body", async () => {
    const token = await netlifySignatureFor(body, "secret");
    expect(await verifyNetlifySignature(`${body} `, token, "secret")).toBe(false);
  });

  it("refuses a token signed with another secret", async () => {
    const token = await netlifySignatureFor(body, "other");
    expect(await verifyNetlifySignature(body, token, "secret")).toBe(false);
  });

  it("refuses an unsigned token, whatever its header claims", async () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const digest = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    const none = `${enc({ alg: "none" })}.${enc({ iss: "netlify", sha256: digest })}.`;
    expect(await verifyNetlifySignature(body, none, "secret")).toBe(false);
    expect(await verifyNetlifySignature(body, null, "secret")).toBe(false);
    expect(await verifyNetlifySignature(body, "garbage", "secret")).toBe(false);
  });

  it("gives every site its own secret, so one site's delivery cannot be replayed at another", async () => {
    const a = await siteHookSecret("master", acmeSite.publicId);
    const b = await siteHookSecret("master", globexSite.publicId);
    expect(a).not.toBe(b);

    const token = await netlifySignatureFor(body, a);
    expect(await verifyNetlifySignature(body, token, b)).toBe(false);
  });
});

describe("reading a submission", () => {
  it("pulls out the contact details and keeps every field the visitor filled in", () => {
    const parsed = parseSubmission(submission());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lead).toMatchObject({
      name: "Dana Reyes",
      email: "dana@example.test",
      phone: "555-0100",
      message: "Water heater is leaking, can you come Thursday?",
      pageUrl: "https://acme.example/contact/",
    });
    // Netlify's bookkeeping and the honeypot are not the visitor's words.
    const labels = parsed.lead.fields.map((f) => f.label.toLowerCase());
    expect(labels).not.toContain("ip");
    expect(labels).not.toContain("user agent");
    expect(labels.some((l) => l.includes("bot"))).toBe(false);
  });

  it("prefers the form's own labels, in the form's order", () => {
    const parsed = parseSubmission({
      id: "abc",
      ordered_human_fields: [
        { name: "service", title: "Which service?", value: "Drain cleaning" },
        { name: "first_name", title: "First name", value: "Sam" },
        { name: "last_name", title: "Last name", value: "Okafor" },
        { name: "bot-field", title: "Don't fill this out", value: "" },
      ],
    });
    if (!parsed.ok) throw new Error("did not parse");
    expect(parsed.lead.fields).toEqual([
      { label: "Which service?", value: "Drain cleaning", key: "service" },
      { label: "First name", value: "Sam", key: "first_name" },
      { label: "Last name", value: "Okafor", key: "last_name" },
    ]);
    expect(parsed.lead.name).toBe("Sam Okafor");
  });

  it("refuses a submission with no id, because a redelivery could not be told apart", () => {
    expect(parseSubmission({ data: { name: "x" } }).ok).toBe(false);
  });

  it("drops an email that is not one, and a page link that is not a web page", () => {
    const parsed = parseSubmission(
      submission({ data: { email: "not an email", referrer: "javascript:alert(1)" } }),
    );
    if (!parsed.ok) throw new Error("did not parse");
    expect(parsed.lead.email).toBeNull();
    expect(parsed.lead.pageUrl).toBeNull();
  });
});

describe("storing leads", () => {
  it("stores a submission once, however many times it is delivered", async () => {
    const payload = submission();
    const first = await record(acmeSite, payload);
    const second = await record(acmeSite, payload);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.providerSubmissionId, payload.id));
    expect(rows).toHaveLength(1);
  });

  it("stores imported history as already read, so the inbox does not open on a wall of 'new'", async () => {
    const result = await record(acmeSite, submission(), { asHistory: true });
    if (!result.created) throw new Error("not created");
    const rows = await db.select({ readAt: leads.readAt }).from(leads).where(eq(leads.id, result.leadId));
    expect(rows[0]!.readAt).not.toBeNull();
  });
});

describe("the client's inbox", () => {
  it("shows a client only their own leads", async () => {
    const mine = await record(globexSite, submission({ data: { name: "Only Globex", email: "g@example.test" } }));
    if (!mine.created) throw new Error("not created");

    const acmeView = await listLeads(db, acme.ctx, { view: "open" });
    expect(acmeView.leads.some((l) => l.name === "Only Globex")).toBe(false);

    const globexView = await listLeads(db, globex.ctx, { view: "open" });
    expect(globexView.leads.some((l) => l.name === "Only Globex")).toBe(true);
  });

  it("answers another client's lead as not found — for reading, changing and deleting", async () => {
    const theirs = await record(globexSite);
    if (!theirs.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, theirs.leadId));

    await expect(openLead(db, acme.ctx, row!.publicId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setLeadStatus(db, acme.ctx, row!.publicId, "won")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setLeadArchived(db, acme.ctx, row!.publicId, true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteLead(db, acme.ctx, row!.publicId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("marks a lead read when the client opens it, but not when an operator is looking", async () => {
    const created = await record(acmeSite);
    if (!created.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, created.leadId));

    const operator = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    const before = await countUnreadLeads(db, acme.ctx);
    await openLead(db, operator, row!.publicId);
    expect(await countUnreadLeads(db, acme.ctx)).toBe(before);

    const seen = await openLead(db, acme.ctx, row!.publicId);
    expect(seen.unread).toBe(true); // as it was when they opened it
    expect(await countUnreadLeads(db, acme.ctx)).toBe(before - 1);
  });

  it("keeps won and lost leads in the inbox, and moves archived ones to Archived", async () => {
    const won = await record(acmeSite, submission({ data: { name: "Will Win", email: "w@example.test" } }));
    const archived = await record(acmeSite, submission({ data: { name: "Put Away", email: "p@example.test" } }));
    if (!won.created || !archived.created) throw new Error("not created");
    const [wonRow] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, won.leadId));
    const [archivedRow] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, archived.leadId));

    await setLeadStatus(db, acme.ctx, wonRow!.publicId, "won");
    await setLeadArchived(db, acme.ctx, archivedRow!.publicId, true);

    const inbox = (await listLeads(db, acme.ctx, { view: "open" })).leads.map((l) => l.publicId);
    const put = (await listLeads(db, acme.ctx, { view: "archived" })).leads.map((l) => l.publicId);
    expect(inbox).toContain(wonRow!.publicId);
    expect(inbox).not.toContain(archivedRow!.publicId);
    expect(put).toContain(archivedRow!.publicId);
  });

  it("erases a deleted lead's details, and the next import does not bring it back", async () => {
    const payload = submission({ data: { name: "Delete Me", email: "gone@example.test", message: "private" } });
    const created = await record(acmeSite, payload);
    if (!created.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, created.leadId));

    await deleteLead(db, acme.ctx, row!.publicId);

    const [stored] = await db.select().from(leads).where(eq(leads.id, created.leadId));
    expect(stored).toMatchObject({ name: null, email: null, message: null, fields: [] });
    expect(stored!.deletedAt).not.toBeNull();

    // Netlify still holds the submission; the backfill re-reads it.
    expect((await record(acmeSite, payload, { asHistory: true })).created).toBe(false);
    for (const view of ["open", "archived"] as const) {
      const listed = await listLeads(db, acme.ctx, { view });
      expect(listed.leads.some((l) => l.publicId === row!.publicId)).toBe(false);
    }
    await expect(openLead(db, acme.ctx, row!.publicId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("keeping the inbox to the newest ten", () => {
  async function freshInbox(name: string) {
    const tenant = await seedTenant(db, name);
    return { tenant, site: await addSite(tenant, name.toLowerCase()) };
  }

  /** A submission received on `day` of October, so the order is unambiguous. */
  function onDay(day: number) {
    const dd = String(day).padStart(2, "0");
    return submission({ created_at: `2026-10-${dd}T15:00:00.000Z`, data: { name: `Day ${day}`, email: `d${day}@example.test` } });
  }

  it("archives the oldest when an eleventh arrives, so ten stay in the inbox", async () => {
    const { tenant, site } = await freshInbox("Initech");
    for (let day = 1; day <= 12; day += 1) await record(site, onDay(day));

    const inbox = (await listLeads(db, tenant.ctx, { view: "open" })).leads.map((l) => l.name);
    const archived = (await listLeads(db, tenant.ctx, { view: "archived" })).leads.map((l) => l.name);
    expect(inbox).toEqual(["Day 12", "Day 11", "Day 10", "Day 9", "Day 8", "Day 7", "Day 6", "Day 5", "Day 4", "Day 3"]);
    expect(archived).toEqual(["Day 2", "Day 1"]);
    // Archived ones no longer count as waiting.
    expect(await countUnreadLeads(db, tenant.ctx)).toBe(10);
  });

  it("archives by when they were sent, so an imported older submission goes straight to Archived", async () => {
    const { tenant, site } = await freshInbox("Hooli");
    for (let day = 11; day <= 20; day += 1) await record(site, onDay(day));
    await record(site, onDay(2), { asHistory: true });

    const archived = (await listLeads(db, tenant.ctx, { view: "archived" })).leads.map((l) => l.name);
    expect(archived).toEqual(["Day 2"]);
  });

  it("does not count leads already archived by hand", async () => {
    const { tenant, site } = await freshInbox("Umbrella");
    for (let day = 1; day <= 10; day += 1) await record(site, onDay(day));
    const [first] = (await listLeads(db, tenant.ctx, { view: "open" })).leads.slice(-1);
    await setLeadArchived(db, tenant.ctx, first!.publicId, true);

    await record(site, onDay(11));
    const inbox = await listLeads(db, tenant.ctx, { view: "open" });
    const archived = (await listLeads(db, tenant.ctx, { view: "archived" })).leads.map((l) => l.name);
    expect(inbox.leads).toHaveLength(10);
    expect(archived).toEqual(["Day 1"]);
  });

  it("leaves other clients' inboxes alone", async () => {
    const before = (await listLeads(db, globex.ctx, { view: "open" })).leads.length;
    const { site } = await freshInbox("Soylent");
    for (let day = 1; day <= 11; day += 1) await record(site, onDay(day));
    expect((await listLeads(db, globex.ctx, { view: "open" })).leads.length).toBe(before);
  });

  async function publicIdOf(tenant: SeededTenant, name: string): Promise<string> {
    const [row] = await db
      .select({ publicId: leads.publicId })
      .from(leads)
      .where(and(eq(leads.organizationId, tenant.organizationId), eq(leads.name, name)));
    return row!.publicId;
  }

  it("keeps what the client marked an enquiry when it moves to Archived, and still shows ten", async () => {
    const { tenant, site } = await freshInbox("Vandelay");
    for (let day = 1; day <= 10; day += 1) await record(site, onDay(day));
    await setLeadStatus(db, tenant.ctx, await publicIdOf(tenant, "Day 1"), "won");
    await setLeadStatus(db, tenant.ctx, await publicIdOf(tenant, "Day 2"), "lost");
    await setLeadStatus(db, tenant.ctx, await publicIdOf(tenant, "Day 3"), "contacted");

    for (let day = 11; day <= 13; day += 1) await record(site, onDay(day));

    const inbox = (await listLeads(db, tenant.ctx, { view: "open" })).leads;
    const archived = (await listLeads(db, tenant.ctx, { view: "archived" })).leads;
    expect(inbox.map((l) => l.name)).toEqual(["Day 13", "Day 12", "Day 11", "Day 10", "Day 9", "Day 8", "Day 7", "Day 6", "Day 5", "Day 4"]);
    expect(archived.map((l) => [l.name, l.status])).toEqual([
      ["Day 3", "contacted"],
      ["Day 2", "lost"],
      ["Day 1", "won"],
    ]);
  });

  it("archives an enquiry once, and later arrivals leave it and its time alone", async () => {
    const { tenant, site } = await freshInbox("Kramerica");
    for (let day = 1; day <= 10; day += 1) await record(site, onDay(day));
    const oldest = await publicIdOf(tenant, "Day 1");
    await setLeadStatus(db, tenant.ctx, oldest, "won");

    const archivedOn = new Date("2026-10-21T08:00:00Z");
    await record(site, onDay(11), { now: archivedOn });
    await record(site, onDay(12), { now: new Date("2026-10-21T09:00:00Z") });

    const [row] = await db
      .select({ status: leads.status, archivedAt: leads.archivedAt })
      .from(leads)
      .where(eq(leads.publicId, oldest));
    expect(row).toEqual({ status: "won", archivedAt: archivedOn });
  });
});

describe("archiving keeps what the client marked", () => {
  async function leadIn(business: string): Promise<{ tenant: SeededTenant; publicId: string }> {
    const tenant = await seedTenant(db, business);
    const site = await addSite(tenant, business.toLowerCase().replace(/\s+/g, "-"));
    const created = await record(site, submission({ data: { name: "Pat Doe", email: "pat@example.test" } }));
    if (!created.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, created.leadId));
    return { tenant, publicId: row!.publicId };
  }

  /** Which tab the enquiry is listed under, and what it is marked there. */
  async function listedAs(tenant: SeededTenant, publicId: string) {
    for (const view of ["open", "archived"] as const) {
      const found = (await listLeads(db, tenant.ctx, { view })).leads.find((l) => l.publicId === publicId);
      if (found) return { view, status: found.status };
    }
    return null;
  }

  it("keeps a won enquiry won when the client archives it, and when they bring it back", async () => {
    const { tenant, publicId } = await leadIn("Pendant Publishing");
    await setLeadStatus(db, tenant.ctx, publicId, "won");

    await setLeadArchived(db, tenant.ctx, publicId, true);
    expect(await listedAs(tenant, publicId)).toEqual({ view: "archived", status: "won" });
    expect(await openLead(db, tenant.ctx, publicId)).toMatchObject({ status: "won", archived: true });

    await setLeadArchived(db, tenant.ctx, publicId, false);
    expect(await listedAs(tenant, publicId)).toEqual({ view: "open", status: "won" });
    expect(await openLead(db, tenant.ctx, publicId)).toMatchObject({ status: "won", archived: false });
  });

  it("leaves an archived enquiry in Archived when the client changes what it is marked", async () => {
    const { tenant, publicId } = await leadIn("Kenny Roasters");
    await setLeadArchived(db, tenant.ctx, publicId, true);
    await setLeadStatus(db, tenant.ctx, publicId, "lost");
    expect(await listedAs(tenant, publicId)).toEqual({ view: "archived", status: "lost" });
  });

  it("keeps the first archive time when Archive is pressed twice", async () => {
    const { tenant, publicId } = await leadIn("Peterman Catalog");
    const first = new Date("2026-10-21T08:00:00Z");
    await setLeadArchived(db, tenant.ctx, publicId, true, { now: first });
    await setLeadArchived(db, tenant.ctx, publicId, true, { now: new Date("2026-10-21T09:00:00Z") });
    const [row] = await db.select({ archivedAt: leads.archivedAt }).from(leads).where(eq(leads.publicId, publicId));
    expect(row!.archivedAt).toEqual(first);
  });

  it("keeps an enquiry archived before outcomes were kept in Archived, and lets the client mark it", async () => {
    const { tenant, publicId } = await leadIn("Monks Cafe");
    // As 0037 left it: archived, and what it was before is gone.
    await db
      .update(leads)
      .set({ status: "archived", archivedAt: new Date("2026-10-20T09:00:00Z") })
      .where(eq(leads.publicId, publicId));
    expect(await listedAs(tenant, publicId)).toEqual({ view: "archived", status: "archived" });

    await setLeadStatus(db, tenant.ctx, publicId, "won");
    expect(await listedAs(tenant, publicId)).toEqual({ view: "archived", status: "won" });
  });

  it("does not take archived as something an enquiry can be marked", () => {
    for (const outcome of ["new", "contacted", "won", "lost"]) expect(isLeadOutcome(outcome)).toBe(true);
    expect(isLeadOutcome("archived")).toBe(false);
    expect(isLeadOutcome("WON")).toBe(false);
    expect(isLeadOutcome(null)).toBe(false);
  });

  it("leaves archived enquiries out of the unread count, whatever they are marked", async () => {
    const { tenant, publicId } = await leadIn("Bania Comedy");
    expect(await countUnreadLeads(db, tenant.ctx)).toBe(1);
    await setLeadArchived(db, tenant.ctx, publicId, true);
    expect(await countUnreadLeads(db, tenant.ctx)).toBe(0);
    expect(await listedAs(tenant, publicId)).toEqual({ view: "archived", status: "new" });
  });

  it("cannot be archived while an operator is viewing as the client", async () => {
    const { tenant, publicId } = await leadIn("Costanza Imports");
    const operator = tenantContextFrom(
      { userId: tenant.userId, organizationId: tenant.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      tenant.organizationId,
      { impersonating: true },
    );
    await expect(setLeadArchived(db, operator, publicId, true)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await listedAs(tenant, publicId)).toEqual({ view: "open", status: "new" });
  });
});

describe("the webhook endpoint", () => {
  async function deliver(sitePublicId: string, body: string, token: string | null) {
    const { POST } = await import("@/app/api/webhooks/netlify-forms/[sitePublicId]/route");
    return POST(
      new Request(`https://portal.example.com/api/webhooks/netlify-forms/${sitePublicId}`, {
        method: "POST",
        headers: token ? { "x-webhook-signature": token } : {},
        body,
      }),
      { params: Promise.resolve({ sitePublicId }) },
    );
  }

  it("refuses everything while the secret is unset", async () => {
    const response = await deliver(acmeSite.publicId, "{}", null);
    expect(response.status).toBe(503);
  });

  it("records a signed delivery in that site's client's inbox, and sends no email of its own", async () => {
    vi.stubEnv("NETLIFY_FORMS_WEBHOOK_SECRET", "master");
    const payload = submission({ data: { name: "Webhook Walt", email: "walt@example.test" } });
    const body = JSON.stringify(payload);
    const token = await netlifySignatureFor(body, await siteHookSecret("master", acmeSite.publicId));

    const first = await deliver(acmeSite.publicId, body, token);
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("recorded");

    const again = await deliver(acmeSite.publicId, body, token);
    expect((await again.json()).status).toBe("duplicate");

    const [row] = await db.select().from(leads).where(eq(leads.providerSubmissionId, payload.id));
    expect(row!.organizationId).toBe(acme.organizationId);
    expect(row!.readAt).toBeNull();
    // Netlify's own notification tells the client; a second email was noise.
    expect(sent).toHaveLength(0);
  });

  it("refuses a delivery signed for one site but sent to another site's address", async () => {
    vi.stubEnv("NETLIFY_FORMS_WEBHOOK_SECRET", "master");
    const payload = submission();
    const body = JSON.stringify(payload);
    const token = await netlifySignatureFor(body, await siteHookSecret("master", acmeSite.publicId));

    const response = await deliver(globexSite.publicId, body, token);
    expect(response.status).toBe(401);
    const rows = await db.select().from(leads).where(eq(leads.providerSubmissionId, payload.id));
    expect(rows).toHaveLength(0);
  });

  it("answers an unknown site exactly like a forged signature", async () => {
    vi.stubEnv("NETLIFY_FORMS_WEBHOOK_SECRET", "master");
    const response = await deliver("NOSUCHSITE", "{}", "a.b.c");
    expect(response.status).toBe(401);
  });
});
