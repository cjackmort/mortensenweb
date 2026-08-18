/**
 * List Square subscription plans and their variation ids.
 *
 * The setup doc used to say "find it in Developer Console → Catalog", which
 * assumes a screen that moves between Square's redesigns and is not where
 * anyone looks first. Asking the API is stable, and it prints exactly the
 * string the database wants — including the `UPDATE` to paste into Neon.
 *
 * The token is read from the environment, never taken as an argument: a value
 * passed on a command line ends up in shell history and in the process list,
 * which for an unrestricted Square access token is a genuine exposure. Same
 * rule as `SECURITY.md` and `docs/square-setup.md`.
 *
 *   npm run square:plans --workspace apps/platform
 *
 * Reads SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT from `.env.local`.
 */

// Marks this file as a module. Without it TypeScript treats a script with no
// imports as global scope, and `main` collides with the one in migrate.ts.
export {};

const SANDBOX = "https://connect.squareupsandbox.com/v2";
const PRODUCTION = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-05-20";

interface CatalogObject {
  id: string;
  type: string;
  subscription_plan_data?: {
    name?: string;
    subscription_plan_variations?: CatalogObject[];
  };
  subscription_plan_variation_data?: {
    name?: string;
    phases?: Array<{
      cadence?: string;
      pricing?: { price?: { amount?: number; currency?: string } };
    }>;
  };
}

async function listPlans(): Promise<void> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "SQUARE_ACCESS_TOKEN is not set.\n" +
        "Add it to apps/platform/.env.local, then run this again.",
    );
    process.exitCode = 1;
    return;
  }

  const production = process.env.SQUARE_ENVIRONMENT === "production";
  const base = production ? PRODUCTION : SANDBOX;

  console.log(`\nSquare ${production ? "PRODUCTION" : "sandbox"} — subscription plans\n`);

  const response = await fetch(`${base}/catalog/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // Both types in one call: a plan carries the name, a variation carries the
    // id we actually want, and asking for plans alone returns variations only
    // when they happen to be embedded.
    body: JSON.stringify({
      object_types: ["SUBSCRIPTION_PLAN", "SUBSCRIPTION_PLAN_VARIATION"],
      include_related_objects: true,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    objects?: CatalogObject[];
    related_objects?: CatalogObject[];
    errors?: Array<{ detail?: string; code?: string }>;
  };

  if (!response.ok) {
    const detail = payload.errors?.[0]?.detail ?? `HTTP ${response.status}`;
    console.error(`Square refused the request: ${detail}`);
    if (response.status === 401) {
      console.error(
        "A 401 usually means the token is for the other environment — " +
          "sandbox and production tokens are not interchangeable.",
      );
    }
    process.exitCode = 1;
    return;
  }

  const all = [...(payload.objects ?? []), ...(payload.related_objects ?? [])];
  const plans = all.filter((o) => o.type === "SUBSCRIPTION_PLAN");
  const variations = all.filter((o) => o.type === "SUBSCRIPTION_PLAN_VARIATION");

  if (variations.length === 0) {
    console.log("No subscription plan variations found.\n");
    console.log(
      plans.length > 0
        ? "There are plans but no frequency options. Add one in Square Dashboard\n" +
            "→ Items & services → Subscription plans → your plan → Add frequency option.\n"
        : "Nothing to do here yet — this is only needed for automatic recurring\n" +
            "billing. One-off payments work without it.\n",
    );
    return;
  }

  for (const variation of variations) {
    const data = variation.subscription_plan_variation_data;
    const phase = data?.phases?.[0];
    const price = phase?.pricing?.price;

    // The variation's own name is often blank; the plan it belongs to carries
    // the recognisable one.
    const parent = plans.find((p) =>
      p.subscription_plan_data?.subscription_plan_variations?.some(
        (v) => v.id === variation.id,
      ),
    );

    const money =
      price?.amount !== undefined
        ? `${(price.amount / 100).toFixed(2)} ${price.currency ?? ""}`.trim()
        : "no price set";

    console.log(`  ${parent?.subscription_plan_data?.name ?? data?.name ?? "(unnamed)"}`);
    console.log(`    cadence:      ${phase?.cadence ?? "unknown"}`);
    console.log(`    price:        ${money}`);
    console.log(`    variation id: ${variation.id}`);
    console.log(
      `\n    UPDATE service_plans SET square_plan_variation_id = '${variation.id}'\n` +
        `     WHERE key = '<your plan key>';\n`,
    );
  }

  console.log(
    "Match each to a `key` in service_plans and run the UPDATE in Neon's SQL editor.\n",
  );
}

listPlans().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
