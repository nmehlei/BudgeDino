ALTER TABLE "transactions" ADD COLUMN "counterparty_iban_enc" "bytea";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "category_set_at" timestamp with time zone;