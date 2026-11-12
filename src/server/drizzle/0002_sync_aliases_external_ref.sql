CREATE TABLE "transaction_dedup_aliases" (
	"account_id" uuid NOT NULL,
	"dedup_bidx" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "transaction_dedup_aliases_account_id_dedup_bidx_pk" PRIMARY KEY("account_id","dedup_bidx")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "external_ref_enc" "bytea";--> statement-breakpoint
ALTER TABLE "transaction_dedup_aliases" ADD CONSTRAINT "transaction_dedup_aliases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_dedup_aliases" ADD CONSTRAINT "transaction_dedup_aliases_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;