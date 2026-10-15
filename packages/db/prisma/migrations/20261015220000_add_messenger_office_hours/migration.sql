-- CreateEnum
CREATE TYPE "MessengerReplyTime" AS ENUM ('FEW_MINUTES', 'FEW_HOURS', 'ONE_DAY');

-- AlterTable
ALTER TABLE "messenger_settings" ADD COLUMN     "officeHours" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "officeHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyTime" "MessengerReplyTime" NOT NULL DEFAULT 'FEW_HOURS',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

