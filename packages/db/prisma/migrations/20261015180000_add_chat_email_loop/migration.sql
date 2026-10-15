-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "unverifiedSender" TEXT;

-- AlterTable
ALTER TABLE "messenger_settings" ADD COLUMN     "emailDelayMinutes" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "replyDomain" TEXT,
ADD COLUMN     "replyFromEmail" TEXT;

