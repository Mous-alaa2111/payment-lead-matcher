CREATE TABLE "agency_staff" (
	"user_id" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "agency_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_staff" ADD CONSTRAINT "agency_staff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_staff" ADD CONSTRAINT "agency_staff_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;