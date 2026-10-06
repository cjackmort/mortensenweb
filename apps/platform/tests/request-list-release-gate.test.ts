import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests } from "@/db/schema";
import { createChangeRequest, listChangeRequests } from "@/db/repositories/client/change-requests";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * A client's request history respects the operator's check.
 *
 * The approval panel only ever offered released previews, but the history
 * below it linked to any verified one — so a client could open a preview the
 * operator had not looked at yet, or was about to send back, and was told it
 * needed their approval.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => close());

async function requestWithBuiltPreview() {
  const request = await createChangeRequest(db, acme.ctx, { title: "Hero photo" });
  await db.update(changeRequests).set({ status: "pr_open" }).where(eq(changeRequests.id, request.id));
  const jobPublicId = newPublicId();
  await db.insert(agentJobs).values({
    publicId: jobPublicId,
    requestId: request.id,
    status: "pr_open",
    previewUrl: "https://deploy-preview-9--acme.netlify.app",
    previewVerifiedAt: new Date(),
  });
  return { request, jobPublicId };
}

describe("the client's request history", () => {
  it("does not link to a preview the operator has not released", async () => {
    const { request } = await requestWithBuiltPreview();

    const row = (await listChangeRequests(db, acme.ctx)).find((r) => r.publicId === request.publicId)!;

    expect(row.previewUrl).toBeNull();
    expect(row.previewReleased).toBe(false);
  });

  it("links to it once it is released", async () => {
    const { request, jobPublicId } = await requestWithBuiltPreview();
    await db
      .update(agentJobs)
      .set({ operatorReleasedAt: new Date() })
      .where(eq(agentJobs.publicId, jobPublicId));

    const row = (await listChangeRequests(db, acme.ctx)).find((r) => r.publicId === request.publicId)!;

    expect(row.previewUrl).toBe("https://deploy-preview-9--acme.netlify.app");
    expect(row.previewReleased).toBe(true);
  });
});
