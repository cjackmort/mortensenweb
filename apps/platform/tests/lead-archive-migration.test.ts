import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * 0037_lead_archived_at.sql, replayed one statement at a time the way Neon's
 * HTTP driver runs it.
 *
 * Before 0037, archiving a lead overwrote its status with `archived`, so the
 * only record that it was archived is that status. The backfill copies that
 * fact into `archived_at` and nothing else: what the status was before is not
 * stored anywhere, and the migration must not guess it.
 *
 * Reads go through raw SQL so this file holds without `archivedAt` in the
 * TypeScript schema, which ships in the code release after this one.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let siteId: string;

const MIGRATION = readFileSync("./drizzle/0037_lead_archived_at.sql", "utf8");

function statements(source: string): string[] {
  return source
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

async function replay(): Promise<void> {
  for (const statement of statements(MIGRATION)) {
    await db.execute(sql.raw(statement));
  }
}

async function addLead(values: { status: "new" | "won" | "archived"; statusChangedAt: Date | null; updatedAt: Date }) {
  const [row] = await db
    .insert(leads)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      siteId,
      providerSubmissionId: newPublicId(),
      receivedAt: new Date("2026-10-01T15:00:00Z"),
      ...values,
    })
    .returning({ id: leads.id });
  return row!.id;
}

async function stored(id: string): Promise<{ status: string; archivedAt: Date | null }> {
  const result = await db.execute(sql`select status, archived_at from leads where id = ${id}`);
  const [row] = (result as unknown as { rows: Array<{ status: string; archived_at: Date | string | null }> }).rows;
  return {
    status: row!.status,
    archivedAt: row!.archived_at === null ? null : new Date(row!.archived_at),
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: acme.organizationId, name: "acme" })
    .returning({ id: sites.id });
  siteId = site!.id;
});

afterAll(async () => {
  await close();
});

describe("0037_lead_archived_at.sql", () => {
  const archivedOn = new Date("2026-10-20T09:00:00Z");
  const touchedOn = new Date("2026-10-20T10:00:00Z");

  it("marks a lead archived before 0037 as archived, from when it was archived, and keeps its status", async () => {
    const legacy = await addLead({ status: "archived", statusChangedAt: archivedOn, updatedAt: touchedOn });
    const noStamp = await addLead({ status: "archived", statusChangedAt: null, updatedAt: touchedOn });
    const won = await addLead({ status: "won", statusChangedAt: archivedOn, updatedAt: touchedOn });
    const waiting = await addLead({ status: "new", statusChangedAt: null, updatedAt: touchedOn });

    await replay();

    // The outcome it had before is gone; `archived` stays as the honest
    // "not recorded" rather than a guess.
    expect(await stored(legacy)).toEqual({ status: "archived", archivedAt: archivedOn });
    expect(await stored(noStamp)).toEqual({ status: "archived", archivedAt: touchedOn });
    expect(await stored(won)).toEqual({ status: "won", archivedAt: null });
    expect(await stored(waiting)).toEqual({ status: "new", archivedAt: null });
  });

  it("can run twice, and never moves a time already recorded", async () => {
    const legacy = await addLead({ status: "archived", statusChangedAt: archivedOn, updatedAt: touchedOn });
    const recorded = new Date("2026-10-22T12:00:00Z");
    await db.execute(sql`update leads set archived_at = ${recorded.toISOString()} where id = ${legacy}`);

    await replay();

    expect(await stored(legacy)).toEqual({ status: "archived", archivedAt: recorded });
  });
});
