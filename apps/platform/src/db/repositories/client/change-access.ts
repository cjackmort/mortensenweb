import { FREE_SMALL_CHANGES_PER_MONTH } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { nextPeriodStart } from "@/lib/requests/free-tier";
import { changeTierOfOrganization, freeSmallChangesUsed } from "../change-tier";
import type { TenantContext } from "../context";

/**
 * The rules this client's change requests follow, as the requests page and the
 * submit action read them (decision D7; the rule is `change-tier.ts`).
 */
export type ChangeAccess =
  | { tier: "plan" }
  | {
      tier: "free";
      /** Free small changes submitted this business month. */
      used: number;
      included: number;
      /** `YYYY-MM-DD`: when the next one opens. */
      resetsOn: string;
    };

/** Null when the account has no client record. */
export async function getChangeAccess(db: Database, ctx: TenantContext, at: Date = new Date()): Promise<ChangeAccess | null> {
  const tier = await changeTierOfOrganization(db, ctx.organizationId);
  if (!tier) return null;
  if (tier.tier === "plan") return { tier: "plan" };

  return {
    tier: "free",
    used: await freeSmallChangesUsed(db, ctx.organizationId, at),
    included: FREE_SMALL_CHANGES_PER_MONTH,
    resetsOn: nextPeriodStart(at),
  };
}
