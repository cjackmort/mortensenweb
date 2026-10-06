import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, servicePlans, subscriptions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * 0026_plans_2026_10.sql, run the way production runs it.
 *
 * Production migrates over Neon's HTTP driver, which sends every statement as
 * its own request with no session between them. PGlite keeps one session, so
 * a migration that leans on session state — a temporary table made in one
 * statement and read in the next — passes the whole suite and then fails on
 * the real database. The first version of this migration did exactly that.
 *
 * So the statements are replayed here one query at a time, against a client
 * still on an old plan, and every migration is checked for temp tables.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

const MIGRATION = readFileSync("./drizzle/0026_plans_2026_10.sql", "utf8");

function statements(source: string): string[] {
  return source
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

async function planId(key: string): Promise<string> {
  const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, key));
  return row!.id;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => {
  await close();
});

describe("0026_plans_2026_10.sql", () => {
  it("moves an old Basic subscriber to Growth at the price they already pay, statement by statement", async () => {
    // Put the client back on an old plan, as production holds them today.
    await db.update(servicePlans).set({ active: true }).where(eq(servicePlans.key, "care-basic"));
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: await planId("care-basic"),
      monthlyPriceCents: 10000,
      billingDay: 1,
      startedOn: "2026-09-01",
    });
    await db.update(clients).set({ compPlanId: await planId("care-plus") }).where(eq(clients.id, acme.clientId));

    for (const statement of statements(MIGRATION)) {
      await db.execute(sql.raw(statement));
    }

    const [sub] = await db
      .select({ planKey: servicePlans.key, price: subscriptions.monthlyPriceCents })
      .from(subscriptions)
      .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
      .where(eq(subscriptions.clientId, acme.clientId));
    expect(sub).toEqual({ planKey: "growth", price: 10000 });

    const [comp] = await db
      .select({ planKey: servicePlans.key })
      .from(clients)
      .innerJoin(servicePlans, eq(servicePlans.id, clients.compPlanId))
      .where(eq(clients.id, acme.clientId));
    expect(comp!.planKey).toBe("pro");

    const [old] = await db.select({ active: servicePlans.active }).from(servicePlans).where(eq(servicePlans.key, "care-basic"));
    expect(old!.active).toBe(false);
  });

  it("can run twice without changing anything the second time", async () => {
    for (const statement of statements(MIGRATION)) {
      await db.execute(sql.raw(statement));
    }
    const [sub] = await db
      .select({ planKey: servicePlans.key })
      .from(subscriptions)
      .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
      .where(eq(subscriptions.clientId, acme.clientId));
    expect(sub!.planKey).toBe("growth");
  });
});

describe("every migration", () => {
  it("keeps no state between statements — no temporary tables", () => {
    for (const file of readdirSync("./drizzle").filter((f) => f.endsWith(".sql"))) {
      const source = readFileSync(`./drizzle/${file}`, "utf8").replace(/--.*$/gm, "");
      expect(source, file).not.toMatch(/CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i);
    }
  });
});
