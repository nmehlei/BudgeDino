CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"external_ref_bidx" text NOT NULL,
	"name_enc" "bytea" NOT NULL,
	"iban_enc" "bytea",
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"visibility" text DEFAULT 'household' NOT NULL,
	"counts_toward_budgets" boolean DEFAULT true NOT NULL,
	"balance_enc" "bytea",
	"balance_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_ids" uuid[] NOT NULL,
	"period_kind" text NOT NULL,
	"amount_minor_enc" "bytea" NOT NULL,
	"currency" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"group" text,
	"is_income" boolean DEFAULT false NOT NULL,
	"is_transfer" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload_enc" "bytea" NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"config_enc" "bytea" NOT NULL,
	"state_enc" "bytea",
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"consent_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"currency" text NOT NULL,
	"rate_per_eur" numeric NOT NULL,
	CONSTRAINT "fx_rates_date_currency_pk" PRIMARY KEY("date","currency")
);
--> statement-breakpoint
CREATE TABLE "household_keys" (
	"household_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"master_key_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_keys_household_id_version_pk" PRIMARY KEY("household_id","version")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"base_currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"role" text NOT NULL,
	"email_bidx" text NOT NULL,
	"email_enc" "bytea" NOT NULL,
	"display_name_enc" "bytea" NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" text NOT NULL,
	"body_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"match_enc" "bytea" NOT NULL,
	"category_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"device_name_enc" "bytea",
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"user_present" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"category_id" uuid,
	"amount_enc" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"dedup_bidx" text NOT NULL,
	"status" text NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount_enc" "bytea" NOT NULL,
	"currency" text NOT NULL,
	"counterparty_enc" "bytea",
	"counterparty_bidx" text,
	"purpose_enc" "bytea",
	"mcc" text,
	"category_id" uuid,
	"category_source" text DEFAULT 'none' NOT NULL,
	"transfer_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_keys" ADD CONSTRAINT "household_keys_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_connector_external_ref" ON "accounts" USING btree ("connector_id","external_ref_bidx");--> statement-breakpoint
CREATE UNIQUE INDEX "household_keys_one_active" ON "household_keys" USING btree ("household_id") WHERE "household_keys"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "members_email_bidx_unique" ON "members" USING btree ("email_bidx");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_account_dedup" ON "transactions" USING btree ("account_id","dedup_bidx");--> statement-breakpoint
CREATE INDEX "transactions_account_booking_date" ON "transactions" USING btree ("account_id","booking_date");--> statement-breakpoint
CREATE INDEX "transactions_transfer_group" ON "transactions" USING btree ("transfer_group_id");