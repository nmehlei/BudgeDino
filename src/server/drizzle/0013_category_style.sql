ALTER TABLE "categories" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "color" text;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_household_key" ON "categories" USING btree ("household_id","key") WHERE "categories"."key" is not null;--> statement-breakpoint
-- Backfill the seeded defaults of existing households by exact English default name, only where the
-- household has exactly one category with that name. Renamed or duplicated ones stay null (tag fallback).
UPDATE "categories" c SET "key" = v.key, "icon" = v.icon, "color" = v.color
FROM (VALUES
  ('Groceries', 'groceries', 'cart', 'green'),
  ('Eating out', 'eating-out', 'silverware-fork-knife', 'orange'),
  ('Transport', 'transport', 'bus', 'blue'),
  ('Housing', 'housing', 'home-variant', 'brown'),
  ('Utilities', 'utilities', 'lightning-bolt', 'amber'),
  ('Insurance', 'insurance', 'shield-check', 'indigo'),
  ('Subscriptions', 'subscriptions', 'play-box-multiple', 'violet'),
  ('Shopping', 'shopping', 'shopping', 'pink'),
  ('Health', 'health', 'heart-pulse', 'rose'),
  ('Kids', 'kids', 'teddy-bear', 'apricot'),
  ('Leisure', 'leisure', 'ticket', 'teal'),
  ('Travel', 'travel', 'airplane', 'sky'),
  ('Gifts & Donations', 'gifts-donations', 'gift', 'red'),
  ('Fees', 'fees', 'receipt-text', 'slate'),
  ('Cash', 'cash', 'cash', 'olive'),
  ('Savings & Investments', 'savings-investments', 'piggy-bank', 'gold'),
  ('Income', 'income', 'cash-plus', 'accent'),
  ('Transfer', 'transfer', 'swap-horizontal', 'grey'),
  ('Uncategorized', 'uncategorized', 'help', 'grey')
) AS v(name, key, icon, color)
WHERE c."name" = v.name
  AND c."key" IS NULL
  AND (SELECT count(*) FROM "categories" d WHERE d."household_id" = c."household_id" AND d."name" = c."name") = 1;
