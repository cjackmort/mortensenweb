import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  organizations,
  paymentRequests,
  payments,
  users,
} from "@/db/schema";
import {
  adminContextFrom,
  tenantContextFrom,
  type AdminContext,
  type SessionLike,
  type TenantContext,
} from "@/db/repositories/context";
import {
  confirmPaymentReceived,
  listOverduePaymentRequests,
  raisePaymentRequest,
} from "@/db/repositories/admin/billing";
import {
  declarePaid,
  getBillingOverview,
  markPaymentInitiated,
} from "@/db/repositories/client/billing";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Billing.
 *
 * The tests that matter here are not the happy path. They are: confirming twice
 * must not bill twice, a client must not be chased after saying they paid, and
 * one tenant must never reach another's invoices. Each of those is a real
 * failure with a real cost — a duplicate ledger row, a wrongly-worded email
 * about money, or a data breach.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

const acme = { orgId: "", clientId: "", ctx: null as unknown as TenantContext };
const globex = { orgId: "", clientId: "", ctx: null as unknown as TenantContext };

function sessionFor(orgId: string, userId: string): SessionLike {
  return {
    userId,
    organizationId: orgId,
    role: "client",
    status: "active",
    sessionEpoch: 0,
  };
}

async function seedTenant(name: string, slug: string, email: string) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug, kind: "client" })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email, role: "client", status: "active" })
      .returning()
  )[0]!;

  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!;

  return {
    orgId: org.id,
    clientId: client.id,
    ctx: tenantContextFrom(sessionFor(org.id, user.id), org.id),
  };
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);

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

  Object.assign(acme, await seedTenant("Acme", "acme", "acme@example.test"));
  Object.assign(globex, await seedTenant("Globex", "globex", "globex@example.test"));
});

describe("raising a payment request", () => {
  it("creates an open invoice with a quotable reference", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(14),
    });

    expect(created.reference).toMatch(/^MW-/);

    const overview = await getBillingOverview(db, acme.ctx);
    expect(overview.current?.amountCents).toBe(9900);
    expect(overview.current?.status).toBe("open");
  });

  it("refuses a zero or negative amount", async () => {
    for (const amountCents of [0, -100, 1.5]) {
      await expect(
        raisePaymentRequest(admin, db, {
          organizationId: acme.orgId,
          amountCents,
          dueOn: isoDaysFromNow(14),
        }),
      ).rejects.toThrow();
    }
  });
});

describe("confirming payment is idempotent", () => {
  it("records exactly one ledger row when confirmed twice", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-1),
    });

    const first = await confirmPaymentReceived(admin, db, created.publicId, {
      method: "venmo",
      receivedOn: isoDaysFromNow(0),
    });
    const second = await confirmPaymentReceived(admin, db, created.publicId, {
      method: "venmo",
      receivedOn: isoDaysFromNow(0),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ok && second.alreadyConfirmed).toBe(true);

    // The thing that actually matters: one payment, not two.
    const ledger = await db.select().from(payments);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amountCents).toBe(9900);
  });

  it("marks the request paid with a named human attached", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 5000,
      dueOn: isoDaysFromNow(7),
    });
    await confirmPaymentReceived(admin, db, created.publicId, {
      method: "cash",
      receivedOn: isoDaysFromNow(0),
    });

    const row = (
      await db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.publicId, created.publicId))
    )[0]!;

    expect(row.status).toBe("paid");
    // The schema check constraint refuses 'paid' without both of these.
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confirmedByUserId).not.toBeNull();
    expect(row.paymentId).not.toBeNull();
  });

  it("reports a request that does not exist rather than throwing", async () => {
    const result = await confirmPaymentReceived(admin, db, newPublicId(), {
      method: "venmo",
      receivedOn: isoDaysFromNow(0),
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("a client who says they paid is not chased", () => {
  it("declarePaid moves the invoice to awaiting_confirmation", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-5),
    });

    expect(await declarePaid(db, acme.ctx, created.publicId)).toEqual({ ok: true });

    const overview = await getBillingOverview(db, acme.ctx);
    expect(overview.current?.status).toBe("awaiting_confirmation");
    // The standing the client sees must not say "overdue" once they have told
    // us they paid.
    expect(overview.standing.state).toBe("awaiting_confirmation");
  });

  it("still appears on the operator's queue, flagged rather than hidden", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-5),
    });
    await declarePaid(db, acme.ctx, created.publicId);

    const queue = await listOverduePaymentRequests(admin, db);
    const row = queue.find((r) => r.publicId === created.publicId);
    expect(row).toBeDefined();
    // Visible, because it is a task for us — but marked so it is not chased.
    expect(row!.awaitingConfirmation).toBe(true);
  });

  it("cannot be used to reopen an invoice that is already paid", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-1),
    });
    await confirmPaymentReceived(admin, db, created.publicId, {
      method: "venmo",
      receivedOn: isoDaysFromNow(0),
    });

    expect(await declarePaid(db, acme.ctx, created.publicId)).toEqual({
      ok: false,
      reason: "not_declarable",
    });
  });

  it("opening the payment app records intent but does not suppress chasing", async () => {
    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-5),
    });
    await markPaymentInitiated(db, acme.ctx, created.publicId);

    const overview = await getBillingOverview(db, acme.ctx);
    expect(overview.current?.initiatedAt).not.toBeNull();

    // Pressing a button is not paying, so the stored status is untouched — and
    // specifically is NOT awaiting_confirmation, which is what would silence
    // the reminder ladder.
    expect(overview.current?.status).toBe("open");
    expect(overview.current?.status).not.toBe("awaiting_confirmation");

    // Stored status and derived standing are different things: nothing flips a
    // row to 'overdue' on its own, that is the dunning job's work, but the
    // client is still shown as overdue because the due date has passed.
    expect(overview.standing.state).toBe("overdue");
  });
});

describe("tenant isolation", () => {
  it("one client cannot see another's invoices", async () => {
    await raisePaymentRequest(admin, db, {
      organizationId: globex.orgId,
      amountCents: 12345,
      dueOn: isoDaysFromNow(7),
    });

    const acmeView = await getBillingOverview(db, acme.ctx);
    expect(acmeView.current).toBeNull();
  });

  it("one client cannot declare another's invoice paid", async () => {
    const globexInvoice = await raisePaymentRequest(admin, db, {
      organizationId: globex.orgId,
      amountCents: 12345,
      dueOn: isoDaysFromNow(-3),
    });

    // Acme guessing Globex's public id must change nothing.
    expect(await declarePaid(db, acme.ctx, globexInvoice.publicId)).toEqual({
      ok: false,
      reason: "not_declarable",
    });

    const row = (
      await db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.publicId, globexInvoice.publicId))
    )[0]!;
    expect(row.status).toBe("open");
  });

  it("one client cannot mark another's invoice as initiated", async () => {
    const globexInvoice = await raisePaymentRequest(admin, db, {
      organizationId: globex.orgId,
      amountCents: 12345,
      dueOn: isoDaysFromNow(-3),
    });

    await markPaymentInitiated(db, acme.ctx, globexInvoice.publicId);

    const row = (
      await db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.publicId, globexInvoice.publicId))
    )[0]!;
    expect(row.initiatedAt).toBeNull();
  });
});

describe("payment lifts a management pause", () => {
  it("restores managed state when the invoice is confirmed", async () => {
    await db
      .update(clients)
      .set({ managementState: "unmanaged", managementPausedReason: "non-payment" })
      .where(eq(clients.id, acme.clientId));

    const created = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: isoDaysFromNow(-40),
    });
    await confirmPaymentReceived(admin, db, created.publicId, {
      method: "venmo",
      receivedOn: isoDaysFromNow(0),
    });

    const row = (
      await db.select().from(clients).where(eq(clients.id, acme.clientId))
    )[0]!;
    expect(row.managementState).toBe("managed");
    expect(row.managementPausedReason).toBeNull();
  });
});
