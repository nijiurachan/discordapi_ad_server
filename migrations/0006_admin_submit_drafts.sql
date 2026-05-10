ALTER TABLE "ad_drafts" ALTER COLUMN "sponsor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD COLUMN "weight" integer;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD COLUMN "auto_approve" boolean;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD COLUMN "ends_in_days" integer;--> statement-breakpoint
ALTER TABLE "ad_drafts" ADD COLUMN "created_by_admin" text;