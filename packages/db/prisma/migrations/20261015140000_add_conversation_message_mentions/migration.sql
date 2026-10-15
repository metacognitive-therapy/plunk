-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "mentionedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
