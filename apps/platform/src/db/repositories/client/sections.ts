import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients } from "@/db/schema";
import type { TenantContext } from "../context";

/**
 * Which optional sections a client's portal shows as tabs.
 *
 * `availability` and `shop` follow the kind of site the operator chose when
 * adding the client (`clients.booking_enabled` / `shop_enabled`).
 * `getStarted` is on while a new client still has setup to do.
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

export async function getClientSections(
  db: Database,
  ctx: TenantContext,
): Promise<ClientSections> {
  const [row] = await db
    .select({ bookingEnabled: clients.bookingEnabled, shopEnabled: clients.shopEnabled })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  if (!row) return NO_CLIENT_SECTIONS;

  return {
    getStarted: false,
    availability: row.bookingEnabled,
    shop: row.shopEnabled,
  };
}
