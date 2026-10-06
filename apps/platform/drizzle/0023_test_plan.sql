-- The operator-only $1 test plan.
--
-- Data only, no schema change, so it can ship in the same release as the code
-- that reads it: until this row exists the plan simply is not offered.
--
-- Not in `@mortensenweb/plans`, so it never reaches the public pricing page.
-- A client is only ever offered the plan an operator assigned them, which is
-- what keeps a dollar-a-month plan from being something anyone can choose.
--
-- `when` is 1789400000000, above 0022's 1789300000000: Drizzle's migrator
-- skips anything below the highest applied `when`, silently.
INSERT INTO "service_plans" (
  "key", "name", "description", "default_monthly_cents",
  "included_changes_per_month", "overage_per_change_cents",
  "includes_analytics", "sort_order", "active", "stripe_price_lookup_key"
)
VALUES (
  'test-plan', 'Test plan',
  'One dollar a month, for trying payments end to end. Not offered to clients.',
  100, 1, NULL, true, 900, true, 'test_plan_monthly_v1'
)
ON CONFLICT ("key") DO NOTHING;
