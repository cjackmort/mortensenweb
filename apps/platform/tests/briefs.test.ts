import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { organizations, siteBriefs, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The brief's not-empty constraint.
 *
 * `site_briefs` refuses a row whose fields are all blank, because dispatching
 * one would ask the agent to build a site from no instruction at all.
 *
 * That constraint bit in the most ordinary case there is: an operator adds a
 * prospect with only a business name, leaves the three optional boxes empty,
 * and clicks Build a demo. Every field the brief was assembled from was
 * optional, so the whole thing came out blank, the insert threw, and — because
 * the action did not guard it — the operator got Next's error page with no
 * explanation and their typing lost.
 *
 * These tests pin both halves: the constraint really does reject an empty
 * brief, and a brief carrying only the baseline body is accepted.
 */

let db: Database;
let close: () => Promise<void>;
let orgId: string;
let userId: string;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(siteBriefs);
  await db.delete(organizations);
  await db.delete(users);

  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Test Co",
        slug: `test-${Math.random().toString(36).slice(2, 8)}`,
        kind: "client",
      })
      .returning()
  )[0]!;
  orgId = org.id;

  const user = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `op-${Math.random().toString(36).slice(2, 8)}@example.test`,
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;
  userId = user.id;
});

const brief = (overrides: Record<string, unknown> = {}) => ({
  publicId: newPublicId(),
  organizationId: orgId,
  kind: "discovery" as const,
  status: "submitted" as const,
  colourDirection: null,
  features: null,
  contentNotes: null,
  body: null,
  authoredByUserId: userId,
  submittedAt: new Date(),
  ...overrides,
});

describe("site_briefs_not_empty", () => {
  it("refuses a brief with nothing in any field", async () => {
    // The regression. Every field here is one the operator may legitimately
    // leave blank, so this combination is reachable from the UI.
    await expect(db.insert(siteBriefs).values(brief())).rejects.toThrow();
  });

  it("refuses fields containing only whitespace", async () => {
    await expect(
      db.insert(siteBriefs).values(
        brief({ colourDirection: "   ", features: "\n", contentNotes: "\t" }),
      ),
    ).rejects.toThrow();
  });

  it("accepts a brief carrying only the baseline body", async () => {
    // What `buildConcept` now always supplies, so the empty case cannot recur.
    const baseline =
      "Build a first version of a website for Test Co. Use the structure and " +
      "visual language already present in this repository, replacing its content.";

    const rows = await db
      .insert(siteBriefs)
      .values(brief({ body: baseline }))
      .returning({ id: siteBriefs.id });

    expect(rows).toHaveLength(1);
  });

  it("accepts a brief with any single field filled", async () => {
    for (const field of [
      "colourDirection",
      "features",
      "contentNotes",
      "body",
    ] as const) {
      const rows = await db
        .insert(siteBriefs)
        .values(brief({ [field]: "something the client asked for" }))
        .returning({ id: siteBriefs.id });
      expect(rows).toHaveLength(1);
    }
  });
});

describe("site_briefs_submitted_complete", () => {
  it("allows a draft with no submitted time", async () => {
    const rows = await db
      .insert(siteBriefs)
      .values(brief({ status: "draft", submittedAt: null, body: "notes" }))
      .returning({ id: siteBriefs.id });
    expect(rows).toHaveLength(1);
  });

  it("refuses a submitted brief with no submitted time", async () => {
    // "Submitted, but at no point" is not a state that should be writable —
    // it is what a dispatched brief would look like if the timestamp were
    // forgotten, and nothing downstream could order it.
    await expect(
      db
        .insert(siteBriefs)
        .values(brief({ status: "submitted", submittedAt: null, body: "notes" })),
    ).rejects.toThrow();
  });
});
