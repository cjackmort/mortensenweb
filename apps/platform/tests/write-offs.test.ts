import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, expenses, organizations, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { addExpense } from "@/db/repositories/admin/finance";
import { deleteExpense } from "@/db/repositories/admin/ledger-deletes";
import {
  clearFreeBuild,
  freeBuildCandidates,
  setFreeBuild,
  writeOffsForYear,
} from "@/db/repositories/admin/write-offs";
import { summarizeWriteOffs } from "@/lib/finance/write-offs";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * "Potential write-offs": the year's recorded expenses by category, plus
 * sites the agency built for free at what it would normally charge.
 *
 * The free sites are the operator's call to include, with a CPA warning on
 * each, so the total is shown both ways. What must hold: a deleted expense is
 * not a write-off, another year's rows are not this year's, and a free site is
 * a per-client value the operator sets, changes and removes, every change
 * audited.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

async function seedClient(name: string, opts: { internal?: boolean } = {}) {
  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${newPublicId().slice(0, 4).toLowerCase()}`, kind: "client" })
    .returning();
  const [client] = await db
    .insert(clients)
    .values({ publicId: newPublicId(), organizationId: org!.id, isInternal: opts.internal ?? false })
    .returning();
  return client!;
}

async function expense(description: string, category: "software" | "hosting" | "fees", amountCents: number, occurredOn: string) {
  return (await addExpense(admin, db, { description, category, amountCents, occurredOn, isRecurring: false }))!;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "ops@example.test", role: "admin", status: "active" })
    .returning();
  admin = adminContextFrom({
    userId: adminUser!.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(expenses);
  await db.delete(clients);
  await db.delete(organizations);
});

describe("summarizeWriteOffs", () => {
  it("totals expenses and free sites, and gives the total with and without the free sites", () => {
    const summary = summarizeWriteOffs(
      2026,
      [
        { category: "software", count: 2, totalCents: 2220 },
        { category: "hosting", count: 3, totalCents: 5700 },
      ],
      [
        { clientPublicId: "a", organizationName: "A", valueCents: 50000, builtOn: "2026-08-01" },
        { clientPublicId: "b", organizationName: "B", valueCents: 35000, builtOn: "2026-10-20" },
      ],
    );

    expect(summary.categories.map((c) => c.category)).toEqual(["hosting", "software"]);
    expect(summary).toMatchObject({
      year: 2026,
      expensesCents: 7920,
      freeBuildsCents: 85000,
      totalWithFreeBuildsCents: 92920,
      totalWithoutFreeBuildsCents: 7920,
    });
  });
});

describe("expenses by category", () => {
  it("groups the year's recorded expenses, leaving out deleted rows and other years", async () => {
    await expense("Figma", "software", 1500, "2026-03-04");
    await expense("Google Workspace", "software", 720, "2026-10-10");
    await expense("Netlify Pro", "hosting", 1900, "2026-10-01");
    await expense("Stripe fee", "fees", 175, "2026-10-08");
    await expense("Last year's laptop", "software", 99900, "2025-12-31");
    const deleted = await expense("Typo", "hosting", 5000, "2026-10-02");
    await deleteExpense(admin, db, deleted.publicId);

    const summary = await writeOffsForYear(admin, db, 2026);

    expect(summary.categories).toEqual([
      { category: "software", count: 2, totalCents: 2220 },
      { category: "hosting", count: 1, totalCents: 1900 },
      { category: "fees", count: 1, totalCents: 175 },
    ]);
    expect(summary.expensesCents).toBe(4295);
  });
});

describe("sites built for free", () => {
  it("adds, edits and removes a free site, auditing each change", async () => {
    const smfa = await seedClient("Scott Mortensen Fine Arts");

    expect(await setFreeBuild(admin, db, smfa.publicId, { valueCents: 50000, builtOn: "2026-08-01" })).toEqual({
      ok: true,
      created: true,
    });
    let summary = await writeOffsForYear(admin, db, 2026);
    expect(summary.freeBuilds).toEqual([
      { clientPublicId: smfa.publicId, organizationName: "Scott Mortensen Fine Arts", valueCents: 50000, builtOn: "2026-08-01" },
    ]);
    expect(summary).toMatchObject({ freeBuildsCents: 50000, totalWithFreeBuildsCents: 50000, totalWithoutFreeBuildsCents: 0 });

    expect(await setFreeBuild(admin, db, smfa.publicId, { valueCents: 75000, builtOn: "2026-08-15" })).toEqual({
      ok: true,
      created: false,
    });
    summary = await writeOffsForYear(admin, db, 2026);
    expect(summary.freeBuilds[0]).toMatchObject({ valueCents: 75000, builtOn: "2026-08-15" });

    expect(await clearFreeBuild(admin, db, smfa.publicId)).toEqual({ ok: true, cleared: true });
    expect((await writeOffsForYear(admin, db, 2026)).freeBuilds).toEqual([]);

    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, smfa.publicId));
    expect(audit.map((a) => a.action).sort()).toEqual([
      "client.free_build_cleared",
      "client.free_build_set",
      "client.free_build_set",
    ]);
    const edit = audit.find((a) => (a.metadata as { previous?: unknown }).previous);
    expect(edit!.metadata).toMatchObject({
      valueCents: 75000,
      builtOn: "2026-08-15",
      previous: { valueCents: 50000, builtOn: "2026-08-01" },
    });
  });

  it("counts a free site in the year it was built", async () => {
    const oneLove = await seedClient("One Love Coffee Lounge");
    await setFreeBuild(admin, db, oneLove.publicId, { valueCents: 50000, builtOn: "2025-11-20" });

    expect((await writeOffsForYear(admin, db, 2026)).freeBuilds).toHaveLength(0);
    expect((await writeOffsForYear(admin, db, 2025)).freeBuildsCents).toBe(50000);
  });

  it("offers only clients without one, and never the agency's own site", async () => {
    const smfa = await seedClient("Scott Mortensen Fine Arts");
    await seedClient("One Love Coffee Lounge");
    await seedClient("MortensenWeb", { internal: true });
    await setFreeBuild(admin, db, smfa.publicId, { valueCents: 50000, builtOn: "2026-08-01" });

    expect((await freeBuildCandidates(admin, db)).map((c) => c.organizationName)).toEqual(["One Love Coffee Lounge"]);
  });

  it("refuses an unknown or internal client, and a value that is not money", async () => {
    const internal = await seedClient("MortensenWeb", { internal: true });
    const real = await seedClient("Real Co");
    const input = { valueCents: 50000, builtOn: "2026-08-01" };

    expect(await setFreeBuild(admin, db, "nope", input)).toEqual({ ok: false, reason: "not_found" });
    expect(await setFreeBuild(admin, db, internal.publicId, input)).toEqual({ ok: false, reason: "not_found" });
    await expect(setFreeBuild(admin, db, real.publicId, { valueCents: 0, builtOn: "2026-08-01" })).rejects.toThrow();
    await expect(setFreeBuild(admin, db, real.publicId, { valueCents: 100, builtOn: "2026-02-30" })).rejects.toThrow();
    expect(await clearFreeBuild(admin, db, "nope")).toEqual({ ok: false, reason: "not_found" });
  });
});
