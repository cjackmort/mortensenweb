import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Database client.
 *
 * Two drivers, one schema:
 *
 *  - **Neon HTTP** in production. Stateless and fast from a Cloudflare Worker.
 *  - **PGlite** for local development and tests — a real Postgres compiled to
 *    WASM, running in-process. This is what lets the whole platform be built
 *    and exercised with no external account and no Docker.
 *
 * Selection is by `DATABASE_URL`: a `postgres://` URL uses Neon, anything else
 * (or nothing at all) falls back to PGlite. That default is deliberate — a
 * missing connection string in development should start a working local
 * database, not crash.
 */

export type Database = NeonHttpDatabase<typeof schema>;

export const isPgliteMode = (): boolean => {
  const url = process.env.DATABASE_URL;
  return !url || !/^postgres(ql)?:\/\//.test(url);
};

let cached: unknown;

/**
 * PGlite is loaded through a runtime dynamic import so the WASM bundle never
 * reaches a production Worker build.
 */
async function createPglite(): Promise<unknown> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR ?? "./.pglite";
  const client = new PGlite(dataDir);
  return drizzlePglite(client, { schema });
}

/**
 * The application database handle.
 *
 * Async because the local driver is imported lazily. Server components and
 * route handlers await it; the connection itself is cached per process.
 */
export async function getDb(): Promise<Database> {
  if (cached) return cached as Database;

  if (isPgliteMode()) {
    cached = await createPglite();
    return cached as Database;
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL as string);
  cached = drizzleNeon(sql, { schema });
  return cached as Database;
}

/** Testing and scripting hook: drop the cached handle. */
export function resetDbCache(): void {
  cached = undefined;
}

export { schema };
