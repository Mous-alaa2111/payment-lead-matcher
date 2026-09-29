ALTER TABLE "payment_connections" ADD COLUMN "synced_through" timestamp with time zone;--> statement-breakpoint
-- last_synced_at is only set on success: connections that already synced continue from there.
UPDATE "payment_connections" SET "synced_through" = "last_synced_at" WHERE "last_synced_at" IS NOT NULL;
