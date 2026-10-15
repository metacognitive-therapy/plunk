-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "agentsEmailedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "messenger_settings" ADD COLUMN     "slackWebhookUrl" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "inboxEmail" BOOLEAN NOT NULL DEFAULT true;

