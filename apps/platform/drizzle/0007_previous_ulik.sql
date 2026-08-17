ALTER TABLE "site_briefs" DROP CONSTRAINT "site_briefs_not_empty";--> statement-breakpoint
ALTER TABLE "site_briefs" ADD CONSTRAINT "site_briefs_not_empty" CHECK (length(btrim(coalesce("site_briefs"."colour_direction", '') || coalesce("site_briefs"."features", '') || coalesce("site_briefs"."content_notes", '') || coalesce("site_briefs"."body", ''), E' 	

')) > 0);