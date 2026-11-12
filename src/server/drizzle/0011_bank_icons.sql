CREATE TABLE "bank_icons" (
	"bank" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
