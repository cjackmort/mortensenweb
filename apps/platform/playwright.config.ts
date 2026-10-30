import { defineConfig } from "@playwright/test";
import { FAKE_STRIPE_URL, PORTAL_PORT, PORTAL_URL, runEnvironment } from "./e2e/env";

/**
 * The checkout run: `npm run e2e:checkout --workspace apps/platform`.
 *
 * Starts the Stripe stand-in and the portal itself, both on ports of their own
 * and on the throwaway database `e2e/prepare.ts` made, so it can run beside a
 * dev server. On demand only; nothing in CI runs it yet.
 *
 * The browser is the bundled Chromium (`npx playwright install chromium`, once)
 * except on Windows, where it is the Edge that ships with the system and
 * nothing needs downloading. `E2E_BROWSER_CHANNEL` overrides either.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  // One database, one portal: the clients are separate but the servers are not.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: PORTAL_URL,
    channel: process.env.E2E_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
    trace: "retain-on-failure",
  },
  webServer: [
    {
      name: "stripe stand-in",
      command: "node --import tsx scripts/preview/fake-stripe.ts",
      url: `${FAKE_STRIPE_URL}/__fake/events`,
      env: runEnvironment,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: "portal",
      command: `npm run dev -- --port ${PORTAL_PORT}`,
      url: `${PORTAL_URL}/login`,
      env: runEnvironment,
      reuseExistingServer: false,
      // The first request compiles; Turbopack on a cold cache is not quick.
      timeout: 240_000,
    },
  ],
});
