import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, sites, users } from "@/db/schema";
import { adminContextFrom, AuthorizationError, tenantContextFrom, type AdminContext } from "@/db/repositories/context";
import { REGISTRARS, stepsFor } from "@/lib/domains/registrars";
import { newPublicId } from "@/lib/ids";
import { onboardingSteps } from "@/lib/onboarding/status";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The domain step: the client buys their own domain, gives us access, and
 * tells us so; the operator sees it with the DNS records to add.
 *
 * Worth testing: a domain recorded in a form nobody can use (a pasted URL,
 * `www.`), the operator never hearing that access was given, an operator
 * viewing as the client confirming on their behalf, and DNS records that
 * differ from the ones the launch email sends.
 */

const outbox: Array<{ to: string; subject: string; text: string }> = [];

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    outbox.push(message);
    return { status: "sent", id: `email_${outbox.length}` };
  },
}));

const domain = await import("@/db/repositories/client/domain");
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
    .values({ publicId: newPublicId(), email: "operator@agency.test", name: "Jordan", role: "admin", status: "active" })
    .returning();
  admin = adminContextFrom({ userId: operator!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  outbox.length = 0;
  vi.unstubAllEnvs();
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  const [row] = await db
    .update(clients)
    .set({ buildPaidAt: new Date() })
    .where(eq(clients.id, acme.clientId))
    .returning({ publicId: clients.publicId });
  publicId = row!.publicId;
});

describe("the registrar list", () => {
  it("names a source and a check date for every registrar", () => {
    for (const registrar of REGISTRARS) {
      expect(registrar.sources.length).toBeGreaterThan(0);
      expect(registrar.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
      expect(registrar.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(registrar.renewal).toMatch(/^\$\d/);
    }
  });

  it("fills our access address into the steps", () => {
    const steps = stepsFor(REGISTRARS[0]!, "domains@agency.test");
    expect(steps.join(" ")).toContain("domains@agency.test");
    expect(steps.join(" ")).not.toContain("{email}");
  });
});

describe("domainAccessEmail", () => {
  it("is DOMAIN_ACCESS_EMAIL when set", async () => {
    vi.stubEnv("DOMAIN_ACCESS_EMAIL", "domains@agency.test");
    expect(await domain.domainAccessEmail(db)).toBe("domains@agency.test");
  });

  it("falls back to the operator's own login", async () => {
    vi.stubEnv("DOMAIN_ACCESS_EMAIL", "");
    expect(await domain.domainAccessEmail(db)).toBe("operator@agency.test");
  });
});

describe("confirmDomainAccess", () => {
  it("saves the bare domain and registrar, stamps it, and tells the operator", async () => {
    const result = await domain.confirmDomainAccess(db, acme.ctx, { domain: "https://www.AcmePlumbing.com/", registrar: "namecheap" });

    expect(result.ok).toBe(true);
    const [row] = await db
      .select({ name: clients.domainName, registrar: clients.domainRegistrar, at: clients.domainAccessConfirmedAt })
      .from(clients)
      .where(eq(clients.id, acme.clientId));
    expect(row).toMatchObject({ name: "acmeplumbing.com", registrar: "namecheap" });
    expect(row!.at).not.toBeNull();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "operator@agency.test", subject: expect.stringContaining("acmeplumbing.com") });
    expect(outbox[0]!.text).toContain("Namecheap");
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "domain.access_confirmed")).limit(1);
    expect(entry?.metadata).toMatchObject({ domain: "acmeplumbing.com", registrar: "namecheap", notified: 1 });
  });

  it("accepts a registrar that is not on the list", async () => {
    const result = await domain.confirmDomainAccess(db, acme.ctx, { domain: "acme.co", registrar: "other" });
    expect(result.ok).toBe(true);
  });

  it.each([
    [{ domain: "", registrar: "namecheap" }, /domain/],
    [{ domain: "not a domain", registrar: "namecheap" }, /domain/],
    [{ domain: "acme.com", registrar: "" }, /where you bought/],
    [{ domain: "acme.com", registrar: "netlify" }, /where you bought/],
  ])("refuses %o and tells nobody", async (input, message) => {
    const result = await domain.confirmDomainAccess(db, acme.ctx, input);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    expect(outbox).toEqual([]);
  });

  it("refuses while an operator is viewing as the client", async () => {
    const operator = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(domain.confirmDomainAccess(db, operator, { domain: "acme.com", registrar: "namecheap" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("shows what was confirmed on the client's page", async () => {
    await domain.confirmDomainAccess(db, acme.ctx, { domain: "acme.com", registrar: "cloudflare" });
    const step = await domain.getDomainStep(db, acme.ctx);
    expect(step).toMatchObject({ domain: "acme.com", registrar: "cloudflare", paid: true });
    expect(step?.confirmedAt).not.toBeNull();
  });
});

describe("the operator's view", () => {
  it("adds a domain step after paid, done once access is confirmed", () => {
    const at = new Date();
    const base = { demoSentAt: at, loginSentAt: at, passwordSetAt: at, paidAt: at, domainAccessAt: null };
    expect(onboardingSteps(base).next).toBe("domain");
    expect(onboardingSteps({ ...base, domainAccessAt: at }).next).toBeNull();
    expect(onboardingSteps(base).steps.map((s) => s.key)).toEqual(["demo", "login", "password", "paid", "domain"]);
  });

  it("gives the Netlify records from the site's Netlify name, as the launch email does", async () => {
    await db.insert(sites).values({ publicId: newPublicId(), organizationId: acme.organizationId, name: "Acme", netlifySiteName: "acme-plumbing" });
    await domain.confirmDomainAccess(db, acme.ctx, { domain: "acme.com", registrar: "cloudflare" });

    const view = await onboarding.getOnboarding(admin, db, publicId);

    expect(view?.domain).toMatchObject({ name: "acme.com", registrar: "Cloudflare Registrar", netlifySiteName: "acme-plumbing" });
    expect(view?.domain?.records).toEqual([
      expect.objectContaining({ type: "A", host: "@", value: "75.2.60.5" }),
      expect.objectContaining({ type: "CNAME", host: "www", value: "acme-plumbing.netlify.app" }),
    ]);
    expect(view?.domain?.operatorNote).toMatch(/DNS only/);
  });

  it("says there are no records yet when the site has no Netlify name", async () => {
    await domain.confirmDomainAccess(db, acme.ctx, { domain: "acme.com", registrar: "namecheap" });
    const view = await onboarding.getOnboarding(admin, db, publicId);
    expect(view?.domain).toMatchObject({ name: "acme.com", netlifySiteName: null, records: [] });
  });
});
