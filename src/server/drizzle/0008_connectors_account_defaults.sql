ALTER TABLE "connectors" ADD COLUMN "default_visibility" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "default_counts_toward_budgets" boolean;