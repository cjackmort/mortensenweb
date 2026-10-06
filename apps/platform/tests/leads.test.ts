import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  listLeads,
  openLead,
  setLeadStatus,
} from "@/db/repositories/client/leads";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
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
      { label: "Which service?", value: "Drain cleaning" },
      { label: "First name", value: "Sam" },
      { label: "Last name", value: "Okafor" },
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

    const acmeView = await listLeads(db, acme.ctx, { view: "all" });
    expect(acmeView.leads.some((l) => l.name === "Only Globex")).toBe(false);

    const globexView = await listLeads(db, globex.ctx, { view: "all" });
    expect(globexView.leads.some((l) => l.name === "Only Globex")).toBe(true);
  });

  it("answers another client's lead as not found — for reading, changing and deleting", async () => {
    const theirs = await record(globexSite);
    if (!theirs.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, theirs.leadId));

    await expect(openLead(db, acme.ctx, row!.publicId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setLeadStatus(db, acme.ctx, row!.publicId, "won")).rejects.toBeInstanceOf(NotFoundError);
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

  it("files a lead by status, and keeps won ones out of the open view", async () => {
    const created = await record(acmeSite, submission({ data: { name: "Will Win", email: "w@example.test" } }));
    if (!created.created) throw new Error("not created");
    const [row] = await db.select({ publicId: leads.publicId }).from(leads).where(eq(leads.id, created.leadId));

    await setLeadStatus(db, acme.ctx, row!.publicId, "won");

    const open = await listLeads(db, acme.ctx, { view: "open" });
    const won = await listLeads(db, acme.ctx, { view: "won" });
    expect(open.leads.some((l) => l.publicId === row!.publicId)).toBe(false);
    expect(won.leads.some((l) => l.publicId === row!.publicId)).toBe(true);
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
    const all = await listLeads(db, acme.ctx, { view: "all" });
    expect(all.leads.some((l) => l.publicId === row!.publicId)).toBe(false);
    await expect(openLead(db, acme.ctx, row!.publicId)).rejects.toBeInstanceOf(NotFoundError);
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
