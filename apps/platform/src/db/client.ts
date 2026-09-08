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

/**
 * The handle is cached on `globalThis`, not in a module variable.
 *
 * In development the bundler gives server components and route handlers
 * separate instances of this module, so a module-scoped cache produces *two*
 * database handles in one process. With Neon that is merely wasteful — the
 * driver is stateless and both talk to the same remote database. With PGlite it
 * is a correctness problem: each handle opens its own embedded Postgres over
 * `./.pglite`, and a row written through a route handler is then invisible to a
 * page rendering in the other instance.
 *
 * That was not hypothetical. An image uploaded through `/api/media/uploads`
 * returned 200, served correctly from `/api/media/assets/...`, and did not
 * appear in the library at all, because the page was reading a different
 * database. Identical code, identical tenant, same process, different answers.
 *
 * `globalThis` is one instance per process by definition, which is exactly the
 * scope a database connection should have. Production is unaffected either way;
 * this is what makes local development tell the truth.
 */
const HANDLE = Symbol.for("mortensenweb.db.handle");

type GlobalWithDb = typeof globalThis & { [HANDLE]?: unknown };

function readCache(): unknown {
  return (globalThis as GlobalWithDb)[HANDLE];
}

function writeCache(value: unknown): void {
  (globalThis as GlobalWithDb)[HANDLE] = value;
}

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
  const existing = readCache();
  if (existing) return existing as Database;

  if (isPgliteMode()) {
    const created = await createPglite();
    writeCache(created);
    return created as Database;
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL as string);
  const created = drizzleNeon(sql, { schema });
  writeCache(created);
  return created;
}

/** Testing and scripting hook: drop the cached handle. */
export function resetDbCache(): void {
  writeCache(undefined);
}

export { schema };
