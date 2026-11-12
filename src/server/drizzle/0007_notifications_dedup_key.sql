ALTER TABLE "notifications" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_member_dedup" ON "notifications" USING btree ("member_id","dedup_key");