CREATE TYPE "public"."match_method" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('matched', 'ambiguous', 'no_match');--> statement-breakpoint
CREATE TABLE "payment_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"external_payment_id" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_status" text,
	"payer_name" text,
	"payer_email" text,
	"payer_phone" text,
	"status" "match_status" NOT NULL,
	"method" "match_method",
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "ghl_token_enc" text;--> statement-breakpoint
ALTER TABLE "payment_connections" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_connections" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "payment_matches" ADD CONSTRAINT "payment_matches_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_matches_payment_idx" ON "payment_matches" USING btree ("client_id","provider","external_payment_id");--> statement-breakpoint
CREATE INDEX "payment_matches_client_paid_idx" ON "payment_matches" USING btree ("client_id","paid_at");