import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  organizations,
  previewDeployments,
  repositoryConnections,
  requestEvents,
  sites,
  webhookDeliveries,
} from "@/db/schema";
import { processGithubDelivery } from "@/db/repositories/admin/webhooks";
import { agentJobMarker } from "@/lib/github/issue";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * GitHub events for a repository two sites share.
 *
 * An event names a repository, not a site. With one site per repository the
 * first matching connection was the only one; with two, whichever row came back
 * first decided which site a preview was recorded against, and a finished
 * build could find no job at all because it only looked under one of them.
 * The job knows which connection it was dispatched through, so that decides.
 */

const NODE = "R_shared";
const HEAD = "b".repeat(40);

let db: Database;
let close: () => Promise<void>;
let tabSiteId: string;
let tabRequestId: string;
let tabJobPublicId: string;

async function siteWithConnection(name: string, netlifySiteName: string) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: `${name}-${newPublicId()}`.toLowerCase(), kind: "client" })
      .returning()
  )[0]!;
  const site = (
    await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: org.id, name, netlifySiteName })
      .returning()
  )[0]!;
  const connection = (
    await db
      .insert(repositoryConnections)
      .values({
        publicId: newPublicId(),
        siteId: site.id,
        owner: "cjackmort",
        name: "site-mortensenweb",
        repoNodeId: NODE,
        installationId: "123",
        defaultBranch: "main",
        allowlisted: true,
      })
      .returning()
  )[0]!;
  return { org, site, connection };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  await db.delete(webhookDeliveries);
  await db.delete(requestEvents);
  await db.delete(previewDeployments);
  await db.delete(agentJobs);
  await db.delete(changeRequests);
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(organizations);

  // The client record is connected first, so a lookup that takes the first
  // matching row lands on it rather than on the tab the job belongs to.
  await siteWithConnection("me-as-client", "client-view");
  const tab = await siteWithConnection("mortensenweb", "mortensenweb-site");
  tabSiteId = tab.site.id;

  const request = (
    await db
      .insert(changeRequests)
      .values({
        publicId: newPublicId(),
        organizationId: tab.org.id,
        siteId: tab.site.id,
        title: "New hero",
        status: "dispatched",
      })
      .returning()
  )[0]!;
  tabRequestId = request.id;
  tabJobPublicId = newPublicId();

  await db.insert(agentJobs).values({
    publicId: tabJobPublicId,
    requestId: request.id,
    repositoryConnectionId: tab.connection.id,
    baseRef: "main",
    status: "dispatched",
    issueNumber: 3,
  });
});

describe("a repository shared by two sites", () => {
  it("records the preview against the site the job was dispatched for", async () => {
    const outcome = await processGithubDelivery(db, {
      deliveryId: "pr-1",
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { node_id: NODE },
        pull_request: {
          number: 9,
          body: `${agentJobMarker(tabJobPublicId)}\n\nNew hero.`,
          html_url: "https://github.com/cjackmort/site-mortensenweb/pull/9",
          draft: false,
          merged: false,
          head: { sha: HEAD, ref: "claude/hero" },
          base: { ref: "main" },
        },
      },
      signatureValid: true,
    });

    expect(outcome.status).toBe("processed");
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.publicId, tabJobPublicId));
    expect(job!.previewUrl).toBe("https://pr-9--mortensenweb-site.netlify.app");
    const [preview] = await db.select().from(previewDeployments);
    expect(preview!.siteId).toBe(tabSiteId);
  });

  it("finds the job for a finished build under either site's connection", async () => {
    await db
      .update(agentJobs)
      .set({ headSha: HEAD, status: "pr_open", prNumber: 9 })
      .where(eq(agentJobs.publicId, tabJobPublicId));

    const outcome = await processGithubDelivery(db, {
      deliveryId: "cs-1",
      event: "check_suite",
      payload: {
        action: "completed",
        repository: { node_id: NODE },
        check_suite: { head_sha: HEAD, conclusion: "failure" },
      },
      signatureValid: true,
    });

    expect(outcome).toMatchObject({ status: "processed", note: "Build failed; nothing shown." });
    const events = await db
      .select()
      .from(requestEvents)
      .where(eq(requestEvents.requestId, tabRequestId));
    expect(events.map((e) => e.kind)).toContain("preview_build_failed");
  });
});
