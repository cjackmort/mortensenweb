-- A plan that exists to be granted rather than sold.
--
-- `clients.comp_plan_id` needs something meaning "unlimited" to point at, and
-- the seed only runs against an empty database — so without this, production
-- has the override and nothing to select in it.
--
-- Null `included_changes_per_month` is what makes it unlimited: the same
-- convention every other plan uses, rather than a large number standing in for
-- infinity, which would eventually be reached by a client who was told it
-- would not be.
--
-- `sort_order` is deliberately high so it sits last, away from the plans a
-- prospect is actually pitched.
--
-- Idempotent on `key`, because a database seeded after this migration was
-- written already has it.

INSERT INTO "service_plans" (
  "key",
  "name",
  "description",
  "default_monthly_cents",
  "included_changes_per_month",
  "overage_per_change_cents",
  "includes_analytics",
  "sort_order",
  "active"
)
VALUES (
  'comp-unlimited',
  'Complimentary — Unlimited',
  'Granted by the agency rather than paid for. Unlimited changes.',
  0,
  NULL,
  NULL,
  true,
  900,
  true
)
ON CONFLICT ("key") DO NOTHING;
