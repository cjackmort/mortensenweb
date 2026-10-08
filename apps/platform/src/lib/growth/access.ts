import {
  GROWTH_FEATURES,
  PLANS,
  planIncludes,
  upgradeBeatsAddOns,
  type GrowthFeature,
  type GrowthFeatureKey,
  type Plan,
  type PlanKey,
} from "@mortensenweb/plans";

/**
 * Which Growth features a client has, and why — the one place that decides.
 *
 * Three routes in, checked in this order:
 *
 *  1. **A comp.** An operator-granted plan is the operator saying "give them
 *     everything"; a complimentary client sees every feature as theirs.
 *  2. **Their plan.** Read from `@mortensenweb/plans` by the plan key, never
 *     stored per client, so moving a client between plans cannot leave them
 *     holding a feature the new plan does not include.
 *  3. **An add-on** — a `client_add_ons` row, bought or granted.
 *
 * A plan key the package does not know (the $1 test plan, a retired key)
 * includes nothing. That is the safe reading: a stray key never unlocks a
 * paid feature.
 */

export type AccessVia = "comp" | "plan" | "add-on";

export interface FeatureAccess {
  feature: GrowthFeature;
  /** How they have it, or null when they do not. */
  via: AccessVia | null;
  /** The cheapest plan that includes it, for the upgrade button. */
  upgradeTo: Plan;
  /**
   * What upgrading would save over buying everything the target plan adds
   * as add-ons, when that is a real saving. Null when it is not, or when
   * they already have the feature.
   */
  upgradeSavesCents: number | null;
  /** Whether "Add for $X/month" can be offered: built, and not already theirs. */
  canAdd: boolean;
}

function isPlanKey(value: string | null | undefined): value is PlanKey {
  return PLANS.some((p) => p.key === value);
}

export function growthAccess(input: {
  planKey: string | null;
  comped: boolean;
  addOns: GrowthFeatureKey[];
}): FeatureAccess[] {
  const plan = isPlanKey(input.planKey) ? input.planKey : null;

  return GROWTH_FEATURES.map((feature) => {
    const via: AccessVia | null = input.comped
      ? "comp"
      : plan && planIncludes(plan, feature.includedFrom)
        ? "plan"
        : input.addOns.includes(feature.key)
          ? "add-on"
          : null;

    const upgradeTo = PLANS.find((p) => p.key === feature.includedFrom)!;
    let upgradeSavesCents: number | null = null;
    if (via === null && plan && plan !== upgradeTo.key) {
      const { saves } = upgradeBeatsAddOns(plan, upgradeTo.key);
      upgradeSavesCents = saves > 0 ? saves : null;
    }

    return {
      feature,
      via,
      upgradeTo,
      upgradeSavesCents,
      canAdd: via === null && feature.available,
    };
  });
}

export function hasFeature(access: FeatureAccess[], key: GrowthFeatureKey): boolean {
  return access.some((a) => a.feature.key === key && a.via !== null);
}
