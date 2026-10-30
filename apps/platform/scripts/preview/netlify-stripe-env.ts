/**
 * Which Stripe variables the portal's Netlify site has, and for which deploy
 * contexts — names, scopes, contexts and the first characters of each key.
 *
 *   npm run netlify:stripe-env --workspace apps/platform
 *
 * Read-only. It calls the Netlify API with the login the Netlify CLI stored
 * (`netlify login`), prints only a recognisable key prefix (`sk_live_`,
 * `sk_test_`, `rk_live_`, `whsec_`), and never a full value or the token. A
 * variable marked secret is returned by Netlify without its value, so for
 * those only the contexts can be shown; the mode of that key is then read from
 * the Stripe dashboard.
 *
 * What to look for: the live key set on anything other than "production".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE_ID = process.env.NETLIFY_SITE_ID ?? "362f9c4c-0646-4f02-af70-06c39ecf031b";
const KEY_PREFIX = /^((sk|rk|pk)_(live|test)_|whsec_)/;
const SECRETISH = /SECRET|KEY/i;

interface EnvValue {
  context: string;
  context_parameter?: string | null;
  value?: string | null;
}

interface EnvVar {
  key: string;
  scopes?: string[];
  is_secret?: boolean;
  values?: EnvValue[];
}

function storedToken(): string {
  const candidates = [
    process.env.APPDATA && join(process.env.APPDATA, "netlify", "Config", "config.json"),
    join(homedir(), ".config", "netlify", "config.json"),
    join(homedir(), "Library", "Preferences", "netlify", "config.json"),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    try {
      const config = JSON.parse(readFileSync(path, "utf8")) as { users?: Record<string, { auth?: { token?: string } }> };
      const token = Object.values(config.users ?? {}).find((user) => user.auth?.token)?.auth?.token;
      if (token) return token;
    } catch {
      // Not there; try the next place the CLI keeps it.
    }
  }
  throw new Error("No stored Netlify login found. Run `netlify login`, then try again.");
}

async function netlify<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.netlify.com/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Netlify answered ${response.status} for ${path.split("?")[0]}`);
  return (await response.json()) as T;
}

const contextOf = (value: EnvValue): string =>
  value.context_parameter ? `${value.context}:${value.context_parameter}` : value.context;

/** The part of a key that says what it is, or why nothing can be shown. */
function prefixOf(variable: EnvVar, value: EnvValue): string {
  if (!SECRETISH.test(variable.key)) return "";
  if (!value.value) return variable.is_secret ? "  (secret: value hidden by Netlify)" : "  (empty)";
  return `  starts ${value.value.match(KEY_PREFIX)?.[0] ?? "(not a Stripe key)"}`;
}

async function main(): Promise<void> {
  const token = storedToken();
  const site = await netlify<{ name: string; account_slug: string }>(`/sites/${SITE_ID}`, token);
  const variables = await netlify<EnvVar[]>(`/accounts/${site.account_slug}/env?site_id=${SITE_ID}`, token);
  const stripe = variables.filter((variable) => /stripe/i.test(variable.key));

  console.log(`${site.name}: ${stripe.length} Stripe variable(s) of ${variables.length}\n`);
  for (const variable of stripe) {
    console.log(`${variable.key}  scopes: ${(variable.scopes ?? []).join(", ") || "none"}`);
    for (const value of variable.values ?? []) console.log(`  ${contextOf(value).padEnd(24)}${prefixOf(variable, value)}`);
  }

  console.log("\nSet for these contexts (names only):");
  const related = variables.filter((variable) => /^(DATABASE_URL|PREVIEW_DATABASE_URL|AUTH_URL|NEXT_PUBLIC_ENVIRONMENT)$/.test(variable.key));
  for (const variable of related) {
    console.log(`  ${variable.key.padEnd(24)}${(variable.values ?? []).map(contextOf).join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
