import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients } from "@/db/schema";
import type { TenantContext } from "../context";
import { hasRequiredOnboardingLeft } from "./onboarding";

/**
 * Which optional sections a client's portal shows as tabs.
 *
 * `availability` and `shop` follow the kind of site the operator chose when
 * adding the client (`clients.booking_enabled` / `shop_enabled`).
 * `getStarted` is on while a new client still has a required to-do left
 * (`lib/onboarding/todos.ts`): paying for the site, their business details,
 * and — for those sites — availability or the shop. Optional to-dos never
 * hold the tab open, so it goes away by itself once the essentials are done.
 *
 * Read once per page by the dashboard layout. Like every tab, this decides
 * what is shown, never what is allowed: each section's pages gate themselves.
 */
export interface ClientSections {
  getStarted: boolean;
  availability: boolean;
  shop: boolean;
}

export const NO_CLIENT_SECTIONS: ClientSections = {
  getStarted: false,
  availability: false,
  shop: false,
};

/** A failed read hides the tab and keeps the others: the page itself still answers. */
async function getStartedOpen(db: Database, ctx: TenantContext): Promise<boolean> {
  try {
    return await hasRequiredOnboardingLeft(db, ctx);
  } catch (error) {
    console.error("[sections] get started read failed", error);
    return false;
  }
}

export async function getClientSections(
  db: Database,
  ctx: TenantContext,
): Promise<ClientSections> {
  const [rows, getStarted] = await Promise.all([
    db
      .select({ bookingEnabled: clients.bookingEnabled, shopEnabled: clients.shopEnabled })
      .from(clients)
      .where(eq(clients.organizationId, ctx.organizationId))
      .limit(1),
    getStartedOpen(db, ctx),
  ]);
  const row = rows[0];
  if (!row) return NO_CLIENT_SECTIONS;

  return {
    getStarted,
    availability: row.bookingEnabled,
    shop: row.shopEnabled,
  };
}
