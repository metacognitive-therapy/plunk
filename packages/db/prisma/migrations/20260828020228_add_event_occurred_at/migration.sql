-- DropIndex
DROP INDEX "events_projectId_contactId_name_createdAt_idx";

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: the DEFAULT above only stamps the migration's own execution time onto
-- pre-existing rows (Postgres evaluates a DDL-time default once, at ALTER TABLE time).
-- Without this UPDATE, every historical event would suddenly read as "just occurred",
-- which would silently corrupt every occurredAt-based recency predicate (triggeredWithin/
-- triggeredOlderThan/notTriggeredWithin) for however long the widest configured window is.
-- createdAt is the best available estimate of occurrence time for rows ingested before this
-- column existed, and using it here preserves the pre-migration meaning of those predicates.
--
-- NOTE: `events` is the highest-volume table in this schema and this migration runs as the
-- Railway pre-deploy step (`prisma migrate deploy`) - this UPDATE touches every existing row
-- unbatched and will hold up that deploy step proportionally to table size. Acceptable for a
-- one-time backfill at current volume; revisit with a batched/chunked backfill if this table
-- grows large enough to make the migration step itself a deploy risk.
UPDATE "events" SET "occurredAt" = "createdAt";

-- CreateIndex
CREATE INDEX "events_projectId_contactId_name_occurredAt_createdAt_idx" ON "events"("projectId", "contactId", "name", "occurredAt", "createdAt");
