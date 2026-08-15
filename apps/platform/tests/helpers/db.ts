import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db/client";

/**
 * Test database harness.
 *
 * Each suite gets a fresh in-memory Postgres (PGlite, no data directory) with
 * the real migrations applied — so constraints, defaults, and enums under test
 * are exactly the ones that will run in production. No Docker, no external
 * service, no shared state between suites.
 */
export async function createTestDb(): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db as never, { migrationsFolder: "./drizzle" });
  return {
    db: db as unknown as Database,
    close: async () => {
      await client.close();
    },
  };
}
