-- The 2026-10-06 plans: Lite $25, Care $50, Growth $100, Pro $150.
--
-- Lite keeps one change a month; Care and above have unlimited changes
-- (`included_changes_per_month` NULL, no overage). What else each includes —
-- the Growth features — lives in `@mortensenweb/plans`, not here.
--
-- New keys rather than repurposed ones, because the old keys' meanings do not
-- line up with the new ladder: `care-lite` was $50, which is now Care, not
-- Lite. Reusing it would have moved every $50 subscriber down to one change a
-- month.
--
-- Existing clients move UP at the price they already pay, decided by the
-- operator: old Lite -> Care, old Basic -> Growth, old Plus and Unlimited ->
-- Pro. `subscriptions.monthly_price_cents` is untouched — this changes what a
-- subscription includes, never what it costs. The same mapping is applied to
-- the two other places a plan is named: a prospect's intended plan and an
-- operator's comp. Their Stripe prices keep working through the portal's
-- legacy lookup-key mapping.
--
-- The old rows are kept, inactive, so history that names them still resolves.
--
-- The mapping is written into each UPDATE rather than held in a temporary
-- table. Production migrates over Neon's HTTP driver, which runs every
-- statement as its own request with no session between them: a temp table
-- created in one statement does not exist in the next. PGlite keeps one
-- session, so the suite passed and the preview database caught it.
--
-- `when` is 1789700000000, above 0025_lead_replies' 1789600000000. Drizzle's
-- migrator skips anything below the highest applied `when`, silently.
-- Hand-written, as 0016 onwards are.

INSERT INTO "service_plans" (
  "key", "name", "description", "default_monthly_cents",
  "included_changes_per_month", "overage_per_change_cents",
  "includes_analytics", "sort_order", "active", "stripe_price_lookup_key"
)
VALUES
  ('lite', 'Lite', 'Hosting, security updates, analytics, and one change a month.',
    2500, 1, 2500, true, 10, true, 'lite_monthly_v2'),
  ('care', 'Care', 'Unlimited changes, plus every website enquiry in your portal.',
    5000, NULL, NULL, true, 20, true, 'care_monthly_v2'),
  ('growth', 'Growth', 'Tools that bring in more customers: reviews and trackable campaigns.',
    10000, NULL, NULL, true, 30, true, 'growth_monthly_v2'),
  ('pro', 'Pro', 'Every Growth feature, including your Google profile managed for you.',
    15000, NULL, NULL, true, 40, true, 'pro_monthly_v2')
ON CONFLICT ("key") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "default_monthly_cents" = excluded."default_monthly_cents",
  "included_changes_per_month" = excluded."included_changes_per_month",
  "overage_per_change_cents" = excluded."overage_per_change_cents",
  "includes_analytics" = excluded."includes_analytics",
  "sort_order" = excluded."sort_order",
  "active" = excluded."active",
  "stripe_price_lookup_key" = excluded."stripe_price_lookup_key";
--> statement-breakpoint
UPDATE "subscriptions" s SET "plan_id" = n."id"
FROM (VALUES
  ('care-lite', 'care'),
  ('care-basic', 'growth'),
  ('care-plus', 'pro'),
  ('care-unlimited', 'pro')
) AS m("old_key", "new_key")
JOIN "service_plans" o ON o."key" = m."old_key"
JOIN "service_plans" n ON n."key" = m."new_key"
WHERE s."plan_id" = o."id";
--> statement-breakpoint
UPDATE "prospects" p SET "plan_id" = n."id"
FROM (VALUES
  ('care-lite', 'care'),
  ('care-basic', 'growth'),
  ('care-plus', 'pro'),
  ('care-unlimited', 'pro')
) AS m("old_key", "new_key")
JOIN "service_plans" o ON o."key" = m."old_key"
JOIN "service_plans" n ON n."key" = m."new_key"
WHERE p."plan_id" = o."id";
--> statement-breakpoint
UPDATE "clients" c SET "comp_plan_id" = n."id"
FROM (VALUES
  ('care-lite', 'care'),
  ('care-basic', 'growth'),
  ('care-plus', 'pro'),
  ('care-unlimited', 'pro')
) AS m("old_key", "new_key")
JOIN "service_plans" o ON o."key" = m."old_key"
JOIN "service_plans" n ON n."key" = m."new_key"
WHERE c."comp_plan_id" = o."id";
--> statement-breakpoint
UPDATE "service_plans" SET "active" = false
WHERE "key" IN ('care-lite', 'care-basic', 'care-plus', 'care-unlimited');
