-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'SUPPRESSED';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sendingPaused" BOOLEAN NOT NULL DEFAULT false;
