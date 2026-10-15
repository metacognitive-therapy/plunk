-- AlterEnum
ALTER TYPE "MessageSource" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "meta" JSONB;
