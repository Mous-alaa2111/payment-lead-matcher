ALTER TABLE "clients" ADD COLUMN "last_auto_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_auto_sync_error" text;