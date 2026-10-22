-- Review requests: a hard bounce or a spam complaint suppresses the address.
--
-- Resend reports both on `/api/webhooks/resend`, and the review requests
-- handler puts the address on that business's `review_suppressions` list, so
-- neither the reminder nor a later request goes to it. Until now the list's
-- reason could only be `unsubscribed`, `sms_opt_out` or `manual`; this widens
-- it to `bounced` and `complained` as well.
--
-- Additive only: every row allowed before is allowed after, so code already
-- deployed is unaffected. Rollback is the same pair of statements with the
-- old list, once no `bounced` or `complained` rows remain.
--
-- `when` is 1791000000000, above 0037 on main (1790800000000) and 0038
-- cart checkout (1790900000000, not on main yet). Drizzle's migrator skips
-- anything below the highest applied `when`, silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

ALTER TABLE "review_suppressions" DROP CONSTRAINT IF EXISTS "review_suppressions_reason_known";--> statement-breakpoint
ALTER TABLE "review_suppressions" ADD CONSTRAINT "review_suppressions_reason_known" CHECK ("reason" IN ('unsubscribed', 'sms_opt_out', 'bounced', 'complained', 'manual'));
