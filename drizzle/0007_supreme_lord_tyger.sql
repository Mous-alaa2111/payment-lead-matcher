CREATE TYPE "public"."writeback_mode" AS ENUM('off', 'preview', 'auto');--> statement-breakpoint
CREATE TYPE "public"."writeback_payment_state" AS ENUM('pushed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."writeback_result" AS ENUM('pending', 'ok', 'error', 'undone');--> statement-breakpoint
CREATE TYPE "public"."writeback_run_status" AS ENUM('running', 'ok', 'capped', 'error', 'killed');--> statement-breakpoint
CREATE TYPE "public"."writeback_tag_status" AS ENUM('added', 'already', 'failed');--> statement-breakpoint
CREATE TYPE "public"."writeback_trigger" AS ENUM('sync', 'cron', 'run_now', 'apply', 'import');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "writeback_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"run_id" uuid,
	"payment_ids" jsonb NOT NULL,
	"contact_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"previous_pipeline_id" text NOT NULL,
	"previous_pipeline_name" text NOT NULL,
	"previous_stage_id" text NOT NULL,
	"previous_stage_name" text NOT NULL,
	"previous_status" text NOT NULL,
	"previous_value" jsonb,
	"new_pipeline_id" text NOT NULL,
	"new_stage_id" text NOT NULL,
	"new_stage_name" text NOT NULL,
	"new_status" text NOT NULL,
	"new_value" jsonb,
	"result" "writeback_result" DEFAULT 'pending' NOT NULL,
	"error" text,
	"tag_status" "writeback_tag_status",
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" text,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "writeback_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"trigger" "writeback_trigger" NOT NULL,
	"applied" boolean NOT NULL,
	"status" "writeback_run_status" DEFAULT 'running' NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"new_needs_review" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "writeback_mode" "writeback_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "writeback_config" jsonb;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "writeback_perms_ok" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "writeback_perms_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "writeback_perms_detail" text;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD COLUMN "refunded_cents" integer;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD COLUMN "refund_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD COLUMN "writeback_state" "writeback_payment_state";--> statement-breakpoint
ALTER TABLE "payment_matches" ADD COLUMN "writeback_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_audit" ADD CONSTRAINT "writeback_audit_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_audit" ADD CONSTRAINT "writeback_audit_run_id_writeback_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."writeback_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_audit" ADD CONSTRAINT "writeback_audit_undone_by_user_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_runs" ADD CONSTRAINT "writeback_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_runs" ADD CONSTRAINT "writeback_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "writeback_audit_client_idx" ON "writeback_audit" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "writeback_audit_one_live_push_idx" ON "writeback_audit" USING btree ("client_id","opportunity_id") WHERE result in ('pending', 'ok');--> statement-breakpoint
CREATE INDEX "writeback_runs_client_idx" ON "writeback_runs" USING btree ("client_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "writeback_runs_one_running_idx" ON "writeback_runs" USING btree ("client_id") WHERE status = 'running';