-- The business's general information, kept once per client.
--
-- Every agent run for a client's site used to start from the request's words
-- alone, so the operator had to type the phone number, the hours and the
-- service list into each brief and each change. This is where those live
-- instead; the portal attaches them to every issue it opens for that client.
--
-- `details` is a JSON object keyed by the field names in
-- `src/lib/business-profile.ts`. A column per field would mean a migration
-- for every field added, and the set is expected to grow.
--
-- Additive only: a new table nothing reads yet. Code already deployed runs
-- unchanged against this schema, which is why it ships ahead of the code.
--
-- Hand-written, as 0016-0021 are: `drizzle-kit generate` cannot run on this
-- repository. `when` is above 0021's 1789200000000, the current high-water mark.

CREATE TABLE IF NOT EXISTS "business_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "last_applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_profiles_details_object" CHECK (jsonb_typeof("details") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_profiles_organization_key" ON "business_profiles" USING btree ("organization_id");
