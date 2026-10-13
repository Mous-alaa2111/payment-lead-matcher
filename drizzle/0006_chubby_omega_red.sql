CREATE TYPE "public"."client_status" AS ENUM('active', 'onboarding', 'paused', 'canceled');--> statement-breakpoint
CREATE TABLE "client_health_status" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"last_refreshed_at" timestamp with time zone NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "client_health_weeks" (
	"client_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"total" integer NOT NULL,
	"contacted" integer NOT NULL,
	"booked" integer NOT NULL,
	"won" integer NOT NULL,
	"lost" integer NOT NULL,
	"revenue_cents" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_health_weeks_client_id_week_start_pk" PRIMARY KEY("client_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "status" "client_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_health_status" ADD CONSTRAINT "client_health_status_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_health_weeks" ADD CONSTRAINT "client_health_weeks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;