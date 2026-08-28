import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  organizations,
  paymentRequests,
  payments,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import {
  adminContextFrom,
  type AdminContext,
} from "@/db/repositories/context";
import {
  confirmPaymentReceived,
  listClientBillingStatus,
  raisePaymentRequest,
} from "@/db/repositories/admin/billing";
import { getOrCreateExtraChangeRequest } from "@/db/repositories/client/checkout";
import { tenantContextFrom, type TenantContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The "who needs a bill this month" list.
 *
 * The one thing worth locking down beyond the happy path: a client's status
 * here must track their most recent *subscription* invoice specifically —
 * an open extra-change purchase must never make a client who is otherwise
 * paid up read as unbilled or blocked from a new invoice, and an archived
 * client must not show up asking to be billed at all.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let planId: string;

async function seedClient(
  name: string,
  monthlyPriceCents: number | null,
): Promise<{ orgId: string; clientId: string; ctx: TenantContext }> {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name, kind: "client" })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `${name}@example.test`,
        role: "client",
        status: "active",
      })
      .returning()
  )[0]!;

  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!;

  if (monthlyPriceCents !== null) {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: client.id,
      planId,
      monthlyPriceCents,
      startedOn: "2026-01-01",
      status: "active",
    });
  }

  return {
    orgId: org.id,
    clientId: client.id,
    ctx: tenantContextFrom(
      {
        userId: user.id,
        organizationId: org.id,
        role: "client",
        status: "active",
        sessionEpoch: 0,
      },
      org.id,
    ),
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(payments);
  await db.delete(paymentRequests);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);
  await db.delete(servicePlans);

  const plan = (
    await db
      .insert(servicePlans)
      .values({
        key: "care-basic",
        name: "Care — Basic",
        defaultMonthlyCents: 9900,
        includedChangesPerMonth: 3,
        overagePerChangeCents: 3900,
        includesAnalytics: true,
      })
      .returning()
  )[0]!;
  planId = plan.id;

  const adminUser = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: "admin@example.test",
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;
  admin = adminContextFrom({
    userId: adminUser.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

describe("listClientBillingStatus", () => {
  it("reads a client with no invoice ever raised as unbilled and raisable", async () => {
    await seedClient("fresh-client", 9900);

    const rows = await listClientBillingStatus(admin, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.neverBilled).toBe(true);
    expect(rows[0]!.canRaise).toBe(true);
    expect(rows[0]!.standing.state).toBe("paid_up");
  });

  it("blocks raising a second invoice while one is open", async () => {
    const client = await seedClient("open-invoice", 9900);
    await raisePaymentRequest(admin, db, {
      organizationId: client.orgId,
      amountCents: 9900,
      dueOn: "2026-09-01",
    });

    const rows = await listClientBillingStatus(admin, db);
    expect(rows[0]!.neverBilled).toBe(false);
    expect(rows[0]!.canRaise).toBe(false);
    expect(rows[0]!.latestRequest?.amountCents).toBe(9900);
  });

  it("reads paid up and raisable again once the open invoice is confirmed", async () => {
    const client = await seedClient("settled-client", 9900);
    const invoice = await raisePaymentRequest(admin, db, {
      organizationId: client.orgId,
      amountCents: 9900,
      dueOn: "2026-08-01",
    });
    await confirmPaymentReceived(admin, db, invoice.publicId, {
      method: "venmo",
      receivedOn: "2026-08-02",
    });

    const rows = await listClientBillingStatus(admin, db);
    expect(rows[0]!.neverBilled).toBe(false);
    expect(rows[0]!.canRaise).toBe(true);
    expect(rows[0]!.standing.state).toBe("paid_up");
  });

  it("shows awaiting_confirmation distinctly and still blocks a new invoice", async () => {
    const client = await seedClient("awaiting-client", 9900);
    const invoice = await raisePaymentRequest(admin, db, {
      organizationId: client.orgId,
      amountCents: 9900,
      dueOn: "2026-08-01",
    });
    await db
      .update(paymentRequests)
      .set({ status: "awaiting_confirmation" })
      .where(eq(paymentRequests.publicId, invoice.publicId));

    const rows = await listClientBillingStatus(admin, db);
    expect(rows[0]!.standing.state).toBe("awaiting_confirmation");
    expect(rows[0]!.canRaise).toBe(false);
  });

  it("is not confused by an open extra-change purchase into the same client", async () => {
    // A client fully paid up on their subscription, but mid-purchase on an
    // unrelated extra-change top-up — the two must not be conflated.
    const client = await seedClient("extra-change-client", 9900);
    const invoice = await raisePaymentRequest(admin, db, {
      organizationId: client.orgId,
      amountCents: 9900,
      dueOn: "2026-08-01",
    });
    await confirmPaymentReceived(admin, db, invoice.publicId, {
      method: "venmo",
      receivedOn: "2026-08-02",
    });
    await getOrCreateExtraChangeRequest(db, client.ctx);

    const rows = await listClientBillingStatus(admin, db);
    expect(rows[0]!.standing.state).toBe("paid_up");
    expect(rows[0]!.canRaise).toBe(true);
  });

  it("excludes archived clients", async () => {
    const client = await seedClient("archived-client", 9900);
    await db
      .update(clients)
      .set({ archivedAt: new Date() })
      .where(eq(clients.id, client.clientId));

    const rows = await listClientBillingStatus(admin, db);
    expect(rows).toHaveLength(0);
  });

  it("flags a missing plan price rather than raising an invoice for $0", async () => {
    await seedClient("no-plan-client", null);

    const rows = await listClientBillingStatus(admin, db);
    expect(rows[0]!.monthlyPriceCents).toBeNull();
    expect(rows[0]!.canRaise).toBe(true);
  });
});
