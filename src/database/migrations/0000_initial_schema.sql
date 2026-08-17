CREATE TYPE "public"."asset_status" AS ENUM('pending', 'downloading', 'stored', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."media_source" AS ENUM('top', 'recent');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_run_type" AS ENUM('SYNC_TOP_HASHTAG_MEDIA', 'SYNC_RECENT_HASHTAG_MEDIA');--> statement-breakpoint
CREATE TABLE "hashtags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ig_hashtag_id" text,
	"ig_hashtag_id_resolved_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"track_from" timestamp with time zone,
	"track_until" timestamp with time zone,
	"top_sync_enabled" boolean DEFAULT true NOT NULL,
	"recent_sync_enabled" boolean DEFAULT true NOT NULL,
	"max_media_per_sync" integer,
	"last_top_synced_at" timestamp with time zone,
	"last_recent_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "sync_run_type" NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"hashtag_id" uuid NOT NULL,
	"triggered_by_message_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"metrics_recorded" integer DEFAULT 0 NOT NULL,
	"asset_jobs_enqueued" integer DEFAULT 0 NOT NULL,
	"hit_item_cap" integer DEFAULT 0 NOT NULL,
	"rate_limit_snapshot" jsonb,
	"last_cursor" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"hashtag_id" uuid NOT NULL,
	"ig_media_id" text NOT NULL,
	"source" "media_source" NOT NULL,
	"page_number" integer NOT NULL,
	"position_in_page" integer NOT NULL,
	"position_overall" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ig_media_id" text NOT NULL,
	"hashtag_id" uuid NOT NULL,
	"media_type" "media_type" NOT NULL,
	"caption" text,
	"permalink" text NOT NULL,
	"source_media_url" text,
	"caption_hashtags" text[],
	"caption_mentions" text[],
	"taken_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_updated_at" timestamp with time zone,
	"like_count" integer,
	"comments_count" integer,
	"metrics_updated_at" timestamp with time zone,
	"first_seen_via" "media_source" NOT NULL,
	"seen_in_top" boolean DEFAULT false NOT NULL,
	"seen_in_recent" boolean DEFAULT false NOT NULL,
	"best_top_rank" integer,
	"is_stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_post_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"hashtag_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"ig_media_id" text NOT NULL,
	"media_type" "media_type" NOT NULL,
	"caption" text,
	"permalink" text NOT NULL,
	"caption_hashtags" text[],
	"caption_mentions" text[],
	"like_count" integer,
	"comments_count" integer,
	"rank" integer,
	"source" "media_source" NOT NULL,
	"changed_fields" text[],
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"status" "asset_status" DEFAULT 'pending' NOT NULL,
	"sha256" text,
	"storage_key" text,
	"storage_provider" text,
	"content_type" text,
	"size_bytes" bigint,
	"fetched_from_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"download_started_at" timestamp with time zone,
	"stored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_posts" ADD CONSTRAINT "media_posts_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_post_history" ADD CONSTRAINT "media_post_history_media_id_media_posts_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_post_history" ADD CONSTRAINT "media_post_history_hashtag_id_hashtags_id_fk" FOREIGN KEY ("hashtag_id") REFERENCES "public"."hashtags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_post_history" ADD CONSTRAINT "media_post_history_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_media_id_media_posts_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hashtags_name_unique" ON "hashtags" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "hashtags_ig_hashtag_id_unique" ON "hashtags" USING btree ("ig_hashtag_id") WHERE "hashtags"."ig_hashtag_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hashtags_active_idx" ON "hashtags" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sync_runs_hashtag_started_idx" ON "sync_runs" USING btree ("hashtag_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_runs_type_started_idx" ON "sync_runs" USING btree ("type","started_at");--> statement-breakpoint
CREATE INDEX "data_points_ig_media_id_idx" ON "data_points" USING btree ("ig_media_id");--> statement-breakpoint
CREATE INDEX "data_points_sync_run_idx" ON "data_points" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "data_points_hashtag_fetched_idx" ON "data_points" USING btree ("hashtag_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_posts_ig_media_id_unique" ON "media_posts" USING btree ("ig_media_id");--> statement-breakpoint
CREATE INDEX "media_posts_hashtag_taken_at_idx" ON "media_posts" USING btree ("hashtag_id","taken_at","id");--> statement-breakpoint
CREATE INDEX "media_posts_last_seen_idx" ON "media_posts" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "media_posts_media_type_idx" ON "media_posts" USING btree ("media_type");--> statement-breakpoint
CREATE UNIQUE INDEX "media_post_history_media_run_unique" ON "media_post_history" USING btree ("media_id","sync_run_id");--> statement-breakpoint
CREATE INDEX "media_post_history_media_captured_idx" ON "media_post_history" USING btree ("media_id","captured_at");--> statement-breakpoint
CREATE INDEX "media_post_history_hashtag_captured_idx" ON "media_post_history" USING btree ("hashtag_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_media_unique" ON "media_assets" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_assets_sha256_idx" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "media_assets_status_idx" ON "media_assets" USING btree ("status");