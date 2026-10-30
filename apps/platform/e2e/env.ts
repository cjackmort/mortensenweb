/**
 * What the checkout run shares between the database preparation, the two
 * servers it starts and the tests: ports, secrets and paths in one place.
 *
 * Every secret here is a made-up value that is only ever valid between the
 * portal and the Stripe stand-in on this machine. Nothing is read from
 * `.env.local`, and the environment below is applied on top of it, so a real
 * key or database URL left in that file cannot reach the run: a variable that
 * is set — even to an empty string — is never overwritten by an env file.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const PORTAL_PORT = 3100;
export const FAKE_STRIPE_PORT = 12111;
export const PORTAL_URL = `http://localhost:${PORTAL_PORT}`;
export const FAKE_STRIPE_URL = `http://localhost:${FAKE_STRIPE_PORT}`;

/** Apart from `.pglite`, so a run never touches the data of the ordinary dev server. */
export const E2E_DB_DIR = resolve(APP_ROOT, ".pglite-e2e");
export const CREDENTIALS_FILE = resolve(APP_ROOT, ".e2e/credentials.json");

const WEBHOOK_SECRET = "whsec_e2e_local_only";

/** The environment of every process the run starts. */
export const runEnvironment: Record<string, string> = {
  // Empty, not absent: this is what pins the portal to the embedded database.
  DATABASE_URL: "",
  PGLITE_DATA_DIR: E2E_DB_DIR,
  E2E_CREDENTIALS_FILE: CREDENTIALS_FILE,

  STRIPE_SECRET_KEY: "sk_test_e2e_local_only",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_CONNECT_WEBHOOK_SECRET: "",
  STRIPE_API_BASE: FAKE_STRIPE_URL,
  FAKE_STRIPE_PORT: String(FAKE_STRIPE_PORT),
  PORTAL_URL,

  AUTH_SECRET: "e2e-only-secret-0123456789abcdef0123456789abcdef",
  AUTH_URL: PORTAL_URL,
  NEXT_PUBLIC_SITE_URL: PORTAL_URL,
  CRON_SECRET: "",

  // Anything that would reach a person or another service from a run.
  RESEND_API_KEY: "",
  TWILIO_AUTH_TOKEN: "",
};
