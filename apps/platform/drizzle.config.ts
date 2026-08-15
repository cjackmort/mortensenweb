import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * Migrations are generated against the Postgres dialect and applied to either
 * Neon (production) or an embedded PGlite database (local development and
 * tests). The schema is identical in both; only the driver differs.
 */
export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  },
  strict: true,
  verbose: true,
} satisfies Config;
