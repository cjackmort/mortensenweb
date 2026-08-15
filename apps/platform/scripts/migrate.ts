/**
 * Apply migrations.
 *
 * Chooses the driver the same way the application does: a `postgres://`
 * DATABASE_URL targets Neon, anything else targets the local PGlite database.
 */

const MIGRATIONS_FOLDER = "./drizzle";

async function main() {
  const url = process.env.DATABASE_URL;
  const usePglite = !url || !/^postgres(ql)?:\/\//.test(url);

  if (usePglite) {
    const dataDir = process.env.PGLITE_DATA_DIR ?? "./.pglite";
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");

    const client = new PGlite(dataDir);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.close();
    console.log(`Migrations applied to local PGlite database at ${dataDir}`);
    return;
  }

  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  const { migrate } = await import("drizzle-orm/neon-http/migrator");

  const db = drizzle(neon(url));
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied to Neon.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
