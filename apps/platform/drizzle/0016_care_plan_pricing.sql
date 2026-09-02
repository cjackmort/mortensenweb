-- Updated Care plan pricing, decided 2026-09-02.
--
-- $50 / $100 / $200 monthly, 1 / 5 / 15 included changes, all three now
-- include analytics (only Basic and Plus did before). A flat $25 covers a
-- change beyond what's included, replacing the old per-tier overage prices.
--
-- `default_monthly_cents` and `overage_per_change_cents` are what a NEW
-- subscription is offered — `subscriptions.monthly_price_cents` locks in the
-- price at signup, so this does not change what an existing client is
-- charged. Keeping the same `key` for care-lite/basic/plus is what makes that
-- true: any existing subscription's `plan_id` still resolves, just to updated
-- go-forward numbers.
--
-- Care — Unlimited is new, not a repurposing of `comp-unlimited` — that plan
-- is $0 and exists to be granted, not sold (see 0010_comp_unlimited_plan.sql).
-- A $300 unlimited tier is a different thing: a real price, sortOrder in the
-- normal run of plans, and unlimited changes because the null convention
-- means "no ceiling," not "free."
--
-- Idempotent on `key`.

INSERT INTO "service_plans" (
  "key", "name", "description", "default_monthly_cents",
  "included_changes_per_month", "overage_per_change_cents",
  "includes_analytics", "sort_order", "active"
)
VALUES
  (
    'care-lite', 'Care — Lite',
    'Hosting, security updates, analytics, and one change a month.',
    5000, 1, 2500, true, 10, true
  ),
  (
    'care-basic', 'Care — Basic',
    'Hosting, security updates, analytics, and five changes a month.',
    10000, 5, 2500, true, 20, true
  ),
  (
    'care-plus', 'Care — Plus',
    'Hosting, security updates, analytics, and fifteen changes a month.',
    20000, 15, 2500, true, 30, true
  ),
  (
    'care-unlimited', 'Care — Unlimited',
    'Hosting, security updates, analytics, and unlimited changes.',
    30000, NULL, NULL, true, 40, true
  )
ON CONFLICT ("key") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "default_monthly_cents" = excluded."default_monthly_cents",
  "included_changes_per_month" = excluded."included_changes_per_month",
  "overage_per_change_cents" = excluded."overage_per_change_cents",
  "includes_analytics" = excluded."includes_analytics",
  "sort_order" = excluded."sort_order",
  "active" = excluded."active";
