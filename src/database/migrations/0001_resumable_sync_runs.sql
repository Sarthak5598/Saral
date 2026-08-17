ALTER TABLE "sync_runs" ADD COLUMN "last_cursor" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;