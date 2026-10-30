/**
 * A clean local database, migrated and seeded, before the servers start.
 *
 * Done before Playwright rather than in its global setup because PGlite is
 * single-writer: once the portal is up it holds the database, and nothing else
 * may open it. Runs the same migrate and seed scripts a developer runs by hand,
 * pointed at `.pglite-e2e` with no `DATABASE_URL`.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { APP_ROOT, CREDENTIALS_FILE, E2E_DB_DIR, runEnvironment } from "./env";

function run(script: string): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: APP_ROOT,
    env: { ...process.env, ...runEnvironment },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`${script} failed (exit ${result.status ?? "signal"}).`);
    process.exit(result.status ?? 1);
  }
}

rmSync(E2E_DB_DIR, { recursive: true, force: true });
rmSync(dirname(CREDENTIALS_FILE), { recursive: true, force: true });
run("scripts/migrate.ts");
run("scripts/preview/seed-welcome.ts");
