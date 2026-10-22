import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { campaigns, campaignScans, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  listCampaignSites,
  setCampaignPaused,
  updateCampaign,
} from "@/db/repositories/client/campaigns";
import { campaignStats } from "@/db/repositories/client/campaign-stats";
import { listClientCampaigns } from "@/db/repositories/admin/campaigns";
import {
  AuthorizationError,
  NotFoundError,
  adminContextFrom,
  tenantContextFrom,
} from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * QR & campaign tracking, end to end below the UI.
 *
 * The failures that matter here are quiet ones: a printed code that stops
 * working, a scan landing in another client's numbers, an IP address
 * slipping into a table, or a chart of zeroes standing in for "nothing yet".
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let acmeSitePublicId: string;
let globexSitePublicId: string;
let unlaunchedSitePublicId: string;

vi.mock("@/db/client", () => ({ getDb: async () => db }));

async function addSite(tenant: SeededTenant, name: string, productionUrl: string | null) {
  const publicId = newPublicId();
  await db.insert(sites).values({ publicId, organizationId: tenant.organizationId, name, productionUrl });
  return publicId;
}

async function create(overrides: Partial<Parameters<typeof createCampaign>[2]> = {}, tenant = acme) {
  const result = await createCampaign(db, tenant.ctx, {
    name: "Spring door hangers",
    placement: "door_hangers",
    sitePublicId: tenant === acme ? acmeSitePublicId : globexSitePublicId,
    destination: "",
    ...overrides,
  });
  if (!result.ok) throw new Error(result.message);
  return getCampaign(db, tenant.ctx, result.publicId);
}

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const GEO = Buffer.from(
  JSON.stringify({ city: "Riverton", subdivision: { code: "UT" }, country: { code: "US" }, postalCode: "84065" }),
).toString("base64");

async function scan(code: string, headers: Record<string, string> = {}, method = "GET") {
  const { GET, HEAD } = await import("@/app/q/[code]/route");
  const handler = method === "HEAD" ? HEAD : GET;
  return handler(
    new Request(`https://portal.example/q/${code}`, {
      method,
      headers: {
        "user-agent": IPHONE,
        "x-nf-client-connection-ip": "203.0.113.9",
        "x-nf-geo": GEO,
        ...headers,
      },
    }),
    { params: Promise.resolve({ code }) },
  );
}

async function scansOf(campaignPublicId: string) {
  const [row] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.publicId, campaignPublicId));
  return db.select().from(campaignScans).where(eq(campaignScans.campaignId, row!.id));
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
  acmeSitePublicId = await addSite(acme, "Acme Plumbing", "https://acme.example");
  globexSitePublicId = await addSite(globex, "Globex", "https://globex.example");
  unlaunchedSitePublicId = await addSite(acme, "Acme new site", null);
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("AUTH_URL", "https://portal.example");
  vi.stubEnv("CAMPAIGN_LINK_BASE", "");
});

// ---------------------------------------------------------------------------

describe("creating a campaign", () => {
  it("gives it a short link to the home page, tagged for analytics", async () => {
    const campaign = await create({ name: "Riverton hangers" });
    expect(campaign.destinationPath).toBe("/");
    expect(campaign.code).toMatch(/^[2-9a-hjkmnp-z]{6}$/);
    expect(campaign.shortLink).toBe(`https://portal.example/q/${campaign.code}`);
    expect(campaign.utmCampaign).toBe("riverton-hangers");
    expect(campaign.destinationUrl).toBe(
      "https://acme.example/?utm_source=door-hangers&utm_medium=qr&utm_campaign=riverton-hangers",
    );
  });

  it("gives two campaigns with the same name separate analytics names", async () => {
    const first = await create({ name: "Yard signs" });
    const second = await create({ name: "Yard signs" });
    expect(first.utmCampaign).toBe("yard-signs");
    expect(second.utmCampaign).toBe("yard-signs-2");
  });

  it("refuses a page on someone else's site", async () => {
    const result = await createCampaign(db, acme.ctx, {
      name: "Sneaky",
      placement: "flyers",
      sitePublicId: acmeSitePublicId,
      destination: "https://elsewhere.example/login",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses another client's site as if it did not exist", async () => {
    const result = await createCampaign(db, acme.ctx, {
      name: "Not mine",
      placement: "flyers",
      sitePublicId: globexSitePublicId,
      destination: "",
    });
    expect(result).toEqual({ ok: false, message: "Pick one of your websites." });
  });

  it("explains that a site with no address yet cannot have a code", async () => {
    const result = await createCampaign(db, acme.ctx, {
      name: "Too early",
      placement: "flyers",
      sitePublicId: unlaunchedSitePublicId,
      destination: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not live/i);
  });

  it("refuses a missing name and an unknown placement", async () => {
    const base = { sitePublicId: acmeSitePublicId, destination: "" };
    expect((await createCampaign(db, acme.ctx, { ...base, name: "  ", placement: "flyers" })).ok).toBe(false);
    expect((await createCampaign(db, acme.ctx, { ...base, name: "Billboard", placement: "billboard" })).ok).toBe(false);
  });

  it("is refused while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(
      createCampaign(db, viewing, { name: "x", placement: "flyers", sitePublicId: acmeSitePublicId, destination: "" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("offers only the client's own sites, with whether each can take a code", async () => {
    const options = await listCampaignSites(db, acme.ctx);
    expect(new Set(options.map((o) => o.name))).toEqual(new Set(["Acme new site", "Acme Plumbing"]));
    expect(options.find((o) => o.name === "Acme new site")?.origin).toBeNull();
  });
});

describe("the short link", () => {
  it("redirects to the client's page and counts the scan, with no IP address stored", async () => {
    const campaign = await create({ name: "Counted", destination: "/offer" });
    const response = await scan(campaign.code);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://acme.example/offer?utm_source=door-hangers&utm_medium=qr&utm_campaign=counted",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");

    const rows = await scansOf(campaign.publicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      device: "mobile",
      city: "Riverton",
      region: "UT",
      country: "US",
      organizationId: acme.organizationId,
    });
    expect(JSON.stringify(rows[0])).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows[0])).not.toContain("84065");
  });

  it("works when the code is typed in capitals", async () => {
    const campaign = await create({ name: "Capitals" });
    expect((await scan(campaign.code.toUpperCase())).status).toBe(302);
  });

  it("answers 404 for a code that does not exist, and for one that cannot exist", async () => {
    expect((await scan("zzzzzz")).status).toBe(404);
    expect((await scan("..%2Fadmin")).status).toBe(404);
  });

  it("keeps redirecting a paused campaign, and stops counting it", async () => {
    const campaign = await create({ name: "Paused" });
    await setCampaignPaused(db, acme.ctx, campaign.publicId, true);
    const response = await scan(campaign.code);
    expect(response.status).toBe(302);
    expect(await scansOf(campaign.publicId)).toHaveLength(0);
  });

  it("counts one person scanning twice as one scan", async () => {
    const campaign = await create({ name: "Twice" });
    await scan(campaign.code);
    await scan(campaign.code);
    expect(await scansOf(campaign.publicId)).toHaveLength(1);
    // A different phone is a different scan.
    await scan(campaign.code, { "x-nf-client-connection-ip": "198.51.100.4" });
    expect(await scansOf(campaign.publicId)).toHaveLength(2);
  });

  it("redirects link previews without counting them", async () => {
    const campaign = await create({ name: "Previews" });
    const response = await scan(campaign.code, { "user-agent": "facebookexternalhit/1.1" });
    expect(response.status).toBe(302);
    expect(await scansOf(campaign.publicId)).toHaveLength(0);
  });

  it("answers HEAD without counting", async () => {
    const campaign = await create({ name: "Head" });
    expect((await scan(campaign.code, {}, "HEAD")).status).toBe(302);
    expect(await scansOf(campaign.publicId)).toHaveLength(0);
  });

  it("follows a changed destination, because the printed code cannot change", async () => {
    const campaign = await create({ name: "Moved" });
    await updateCampaign(db, acme.ctx, campaign.publicId, { name: "Moved", destination: "/winter" });
    const response = await scan(campaign.code);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/winter");
  });

  it("refuses a flood from one address", async () => {
    const campaign = await create({ name: "Flood" });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await scan(campaign.code, { "x-nf-client-connection-ip": "192.0.2.77" })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 302).length).toBeLessThan(40);
  });
});

describe("pausing and editing", () => {
  it("cannot touch another client's campaign", async () => {
    const campaign = await create({ name: "Acme only" });
    await expect(setCampaignPaused(db, globex.ctx, campaign.publicId, true)).rejects.toThrow(NotFoundError);
    await expect(getCampaign(db, globex.ctx, campaign.publicId)).rejects.toThrow(NotFoundError);
    const update = await updateCampaign(db, globex.ctx, campaign.publicId, { name: "Mine now", destination: "" });
    expect(update.ok).toBe(false);
  });

  it("keeps the analytics name when the campaign is renamed", async () => {
    const campaign = await create({ name: "Original" });
    await updateCampaign(db, acme.ctx, campaign.publicId, { name: "Renamed", destination: "" });
    const after = await getCampaign(db, acme.ctx, campaign.publicId);
    expect(after.name).toBe("Renamed");
    expect(after.utmCampaign).toBe("original");
  });
});

describe("the numbers", () => {
  it("says there is nothing yet rather than reporting zeroes", async () => {
    const empty = await seedTenant(db, "Empty");
    const stats = await campaignStats(db, empty.ctx, { days: 30 });
    expect(stats.allTime).toBe(0);
    expect(stats.hasScansInWindow).toBe(false);
  });

  it("counts by day, campaign, device and town, inside the client's own data only", async () => {
    const tenant = await seedTenant(db, "Counter");
    const sitePublicId = await addSite(tenant, "Counter site", "https://counter.example");
    const hangers = await create({ name: "Hangers", sitePublicId }, tenant);
    const truck = await create({ name: "Truck", placement: "truck", sitePublicId }, tenant);

    await scan(hangers.code, { "x-nf-client-connection-ip": "10.0.0.1" });
    await scan(hangers.code, { "x-nf-client-connection-ip": "10.0.0.2", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    await scan(truck.code, {
      "x-nf-client-connection-ip": "10.0.0.3",
      "x-nf-geo": Buffer.from(JSON.stringify({ city: "Draper", subdivision: { code: "UT" }, country: { code: "US" } })).toString("base64"),
    });

    const stats = await campaignStats(db, tenant.ctx, { days: 30 });
    expect(stats.total).toBe(3);
    expect(stats.series).toHaveLength(30);
    expect(stats.series.reduce((sum, day) => sum + day.scans, 0)).toBe(3);
    expect(stats.byCampaign.map((c) => [c.name, c.scans])).toEqual([
      ["Hangers", 2],
      ["Truck", 1],
    ]);
    expect(stats.byDevice).toEqual(
      expect.arrayContaining([
        { label: "Phone", value: 2 },
        { label: "Computer", value: 1 },
      ]),
    );
    expect(stats.byTown).toEqual([
      { label: "Riverton, UT", value: 2 },
      { label: "Draper, UT", value: 1 },
    ]);

    // One campaign's own view.
    const truckOnly = await campaignStats(db, tenant.ctx, { days: 30, campaignPublicId: truck.publicId });
    expect(truckOnly.total).toBe(1);

    // And none of it is visible to anyone else.
    const other = await campaignStats(db, globex.ctx, { days: 30, campaignPublicId: truck.publicId });
    expect(other.total).toBe(0);

    const listed = await listCampaigns(db, tenant.ctx, { days: 30 });
    expect(listed.find((c) => c.publicId === hangers.publicId)?.scansInWindow).toBe(2);
    expect(listed.find((c) => c.publicId === hangers.publicId)?.daily).toHaveLength(30);
  });
});

describe("the operator's view", () => {
  it("lists one client's campaigns with their scan counts", async () => {
    const tenant = await seedTenant(db, "Admin view");
    const sitePublicId = await addSite(tenant, "Admin view site", "https://adminview.example");
    const campaign = await create({ name: "Listed", sitePublicId }, tenant);
    await scan(campaign.code, { "x-nf-client-connection-ip": "10.9.9.9" });

    const [client] = await db.query.clients.findMany({
      where: (c, { eq: equals }) => equals(c.organizationId, tenant.organizationId),
    });
    const admin = adminContextFrom({
      userId: tenant.userId,
      organizationId: null,
      role: "admin",
      status: "active",
      sessionEpoch: 0,
    });
    const rows = await listClientCampaigns(admin, db, client!.publicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Listed", scansTotal: 1, scansInWindow: 1, paused: false });
  });
});
