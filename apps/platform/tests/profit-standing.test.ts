import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, expenses, organizations, payments, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { addExpense, profitStanding } from "@/db/repositories/admin/finance";
import { standingOf } from "@/lib/finance/standing";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * "Are we in the green?" at the top of admin Payments: this month and all
 * time, each the ledger's income less fees less expenses.
 *
 * What must hold: a month counts only its own rows, all time counts every
 * month up to the end of this one, deleted rows count nowhere, and exactly
 * zero is neither green nor red.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let clientId: string;

async function payment(amountCents: number, receivedOn: string, voided = false) {
  const publicId = newPublicId();
  await db.insert(payments).values({
    publicId,
    clientId,
    amountCents,
    method: "venmo",
    idempotencyKey: `test:${publicId}`,
    receivedOn,
    ...(voided ? { status: "void" as const, voidedAt: new Date(), voidReason: "test" } : {}),
  });
}

async function expense(amountCents: number, occurredOn: string, category: "software" | "fees" = "software") {
  return (await addExpense(admin, db, {
    description: "Test expense",
    category,
    amountCents,
    occurredOn,
    isRecurring: false,
  }))!;
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
  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: "Client", slug: `client-${newPublicId().slice(0, 6).toLowerCase()}`, kind: "client" })
    .returning();
  const [client] = await db
    .insert(clients)
    .values({ publicId: newPublicId(), organizationId: org!.id })
    .returning();
  clientId = client!.id;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(payments);
  await db.delete(expenses);
});

describe("standingOf", () => {
  it("is green when income beats what went out", () => {
    expect(standingOf(1)).toEqual({ tone: "green", label: "In the green" });
  });

  it("is red when more went out than came in", () => {
    expect(standingOf(-1)).toEqual({ tone: "red", label: "In the red" });
  });

  it("is neither at exactly zero", () => {
    expect(standingOf(0)).toEqual({ tone: "even", label: "Breaking even" });
  });
});

describe("profitStanding", () => {
  it("counts only the month's own rows for the month, and every earlier month for all time", async () => {
    await payment(30000, "2026-08-26");
    await expense(2149, "2026-05-19");
    await payment(5000, "2026-10-29");
    await expense(967, "2026-10-18");
    await expense(33, "2026-10-06", "fees");

    const standing = await profitStanding(admin, db, "2026-10");

    expect(standing.month).toMatchObject({
      yearMonth: "2026-10",
      incomeCents: 5000,
      feesCents: 33,
      expensesCents: 967,
      profitCents: 4000,
    });
    expect(standing.allTime).toMatchObject({
      incomeCents: 35000,
      feesCents: 33,
      expensesCents: 3116,
      profitCents: 31851,
      since: "2026-05-19",
    });
  });

  it("goes red when a month spent more than it took", async () => {
    await expense(8737, "2026-10-21");
    await payment(100, "2026-10-06");

    const standing = await profitStanding(admin, db, "2026-10");

    expect(standing.month.profitCents).toBe(-8637);
    expect(standingOf(standing.month.profitCents).tone).toBe("red");
  });

  it("leaves out deleted expenses and voided payments", async () => {
    await payment(5000, "2026-10-02", true);
    const gone = await expense(2000, "2026-10-03");
    await db.update(expenses).set({ deletedAt: new Date() }).where(eq(expenses.id, gone.id));
    await payment(1000, "2026-10-04");

    const standing = await profitStanding(admin, db, "2026-10");

    expect(standing.month.profitCents).toBe(1000);
    expect(standing.allTime.profitCents).toBe(1000);
  });

  it("does not count rows dated after the month shown", async () => {
    await payment(5000, "2026-11-02");
    await payment(1000, "2026-10-04");

    const standing = await profitStanding(admin, db, "2026-10");

    expect(standing.allTime.incomeCents).toBe(1000);
  });

  it("has no start date when the ledger is empty", async () => {
    const standing = await profitStanding(admin, db, "2026-10");

    expect(standing.allTime).toMatchObject({ profitCents: 0, since: null });
  });
});
