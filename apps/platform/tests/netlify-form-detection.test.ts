import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { organizations, sites, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Netlify's form detection, which a site created through its API starts with
 * switched off.
 *
 * Nothing about that state looks wrong. The form posts, Netlify answers, the
 * leads inbox connects — and no submission is ever stored, so the inbox stays
 * empty for a site that is plainly healthy. Seen on `tipsy-talons`, 2026-10-08.
 */

const getSite = vi.fn();
const enableFormDetection = vi.fn();
const connectFormsWebhook = vi.fn();

vi.mock("@/lib/netlify/api", () => ({
  isNetlifyConfigured: () => true,
  getSite: (...args: unknown[]) => getSite(...args),
  enableFormDetection: (...args: unknown[]) => enableFormDetection(...args),
  connectFormsWebhook: (...args: unknown[]) => connectFormsWebhook(...args),
  listFormSubmissions: async () => [],
}));

const { connectSiteForms } = await import("@/db/repositories/admin/leads");
const actual = await vi.importActual<typeof import("@/lib/netlify/api")>("@/lib/netlify/api");

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let orgId: string;

const DETECTION_OFF = { html: { pretty_urls: false }, ignore_html_forms: true };

async function newSite() {
  return (
    await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: orgId,
        name: "site",
        status: "draft",
        netlifySiteId: "site-uuid-1",
      })
      .returning()
  )[0]!;
}

async function siteRow(id: string) {
  return (await db.select().from(sites).where(eq(sites.id, id)))[0]!;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  getSite.mockReset();
  enableFormDetection.mockReset();
  connectFormsWebhook.mockReset();
  connectFormsWebhook.mockResolvedValue({ hookId: "hook-1" });
  vi.stubEnv("NETLIFY_FORMS_WEBHOOK_SECRET", "master");
  vi.stubEnv("AUTH_URL", "https://portal.example.test");

  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);

  const admin = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!;
  ctx = adminContextFrom({
    userId: admin.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });

  orgId = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" })
      .returning()
  )[0]!.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connecting the leads inbox", () => {
  it("switches form detection on when it is off, and says a redeploy is needed", async () => {
    getSite.mockResolvedValue({ id: "site-uuid-1", processing_settings: DETECTION_OFF });
    enableFormDetection.mockResolvedValue({
      id: "site-uuid-1",
      processing_settings: { ...DETECTION_OFF, ignore_html_forms: false },
    });
    const site = await newSite();

    const outcome = await connectSiteForms(ctx, db, site.publicId);

    expect(outcome).toEqual({ ok: true, imported: 0, redeployNeeded: true });
    // The current settings go with it, because Netlify replaces the object
    // and would otherwise reset whatever the site had chosen.
    expect(enableFormDetection).toHaveBeenCalledWith("site-uuid-1", DETECTION_OFF);
    expect(connectFormsWebhook).toHaveBeenCalledOnce();
    expect((await siteRow(site.id)).formsHookId).toBe("hook-1");
  });

  it("leaves a site that is already detecting forms alone", async () => {
    getSite.mockResolvedValue({
      id: "site-uuid-1",
      processing_settings: { html: { pretty_urls: true }, ignore_html_forms: false },
    });
    const site = await newSite();

    const outcome = await connectSiteForms(ctx, db, site.publicId);

    expect(outcome).toEqual({ ok: true, imported: 0, redeployNeeded: false });
    expect(enableFormDetection).not.toHaveBeenCalled();
    expect(connectFormsWebhook).toHaveBeenCalledOnce();
  });

  it("refuses, and registers no hook, when Netlify will not switch detection on", async () => {
    getSite.mockResolvedValue({ id: "site-uuid-1", processing_settings: DETECTION_OFF });
    enableFormDetection.mockRejectedValue(new Error("Netlify request failed (HTTP 403)."));
    const site = await newSite();

    const outcome = await connectSiteForms(ctx, db, site.publicId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("HTTP 403");
    expect(outcome.message).toContain("form detection");
    expect(outcome.message).toContain("redeploy");
    expect(connectFormsWebhook).not.toHaveBeenCalled();
    expect((await siteRow(site.id)).formsConnectedAt).toBeNull();
  });

  it("refuses when Netlify answers the change but still reports detection off", async () => {
    getSite.mockResolvedValue({ id: "site-uuid-1", processing_settings: DETECTION_OFF });
    enableFormDetection.mockResolvedValue({ id: "site-uuid-1", processing_settings: DETECTION_OFF });
    const site = await newSite();

    const outcome = await connectSiteForms(ctx, db, site.publicId);

    expect(outcome.ok).toBe(false);
    expect(connectFormsWebhook).not.toHaveBeenCalled();
  });

  it("refuses when Netlify no longer has the site", async () => {
    getSite.mockResolvedValue(null);
    const site = await newSite();

    const outcome = await connectSiteForms(ctx, db, site.publicId);

    expect(outcome.ok).toBe(false);
    expect(connectFormsWebhook).not.toHaveBeenCalled();
  });
});

describe("creating a site", () => {
  const fetchMock = vi.fn();

  function respond(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function requestBody(call: number) {
    return JSON.parse(String((fetchMock.mock.calls[call]![1] as RequestInit).body));
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "token");
  });

  const created = {
    id: "new-site",
    name: "acme-abc123",
    url: "http://acme-abc123.netlify.app",
    ssl_url: "https://acme-abc123.netlify.app",
    admin_url: "https://app.netlify.com/projects/acme-abc123",
  };

  it("asks for form detection on, keeping pretty URLs, and stops there when Netlify agrees", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(
        { ...created, processing_settings: { html: { pretty_urls: true }, ignore_html_forms: false } },
        201,
      ),
    );

    const site = await actual.createSite({ name: "acme-abc123", accountSlug: "mortensen" });

    expect(site.id).toBe("new-site");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.netlify.com/api/v1/mortensen/sites");
    expect(requestBody(0).processing_settings).toEqual({
      skip: false,
      ignore_html_forms: false,
      html: { pretty_urls: true },
    });
  });

  it("follows up with a PATCH when the create ignored the setting", async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(
          { ...created, processing_settings: { html: { pretty_urls: true }, ignore_html_forms: true } },
          201,
        ),
      )
      .mockResolvedValueOnce(
        respond({
          ...created,
          processing_settings: { html: { pretty_urls: true }, ignore_html_forms: false },
        }),
      );

    const site = await actual.createSite({ name: "acme-abc123", accountSlug: "mortensen" });

    expect(site.processing_settings?.ignore_html_forms).toBe(false);
    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe("https://api.netlify.com/api/v1/sites/new-site");
    expect(init.method).toBe("PATCH");
    expect(requestBody(1)).toEqual({
      processing_settings: { html: { pretty_urls: true }, ignore_html_forms: false },
    });
  });

  it("still returns the new site when the follow-up fails, so its id is not lost", async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond({ ...created, processing_settings: { ignore_html_forms: true } }, 201),
      )
      .mockResolvedValueOnce(respond({ message: "nope" }, 500));

    const site = await actual.createSite({ name: "acme-abc123", accountSlug: "mortensen" });

    expect(site.id).toBe("new-site");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
