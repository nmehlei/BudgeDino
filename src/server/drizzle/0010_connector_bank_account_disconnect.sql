ALTER TABLE "accounts" ALTER COLUMN "connector_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "household_id" uuid;--> statement-breakpoint
UPDATE "accounts" SET "household_id" = "connectors"."household_id" FROM "connectors" WHERE "accounts"."connector_id" = "connectors"."id";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "household_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "bank" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "display_name_enc" "bytea";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
