-- AlterTable
ALTER TABLE "messenger_settings" ADD COLUMN     "userAttributes" TEXT[] DEFAULT ARRAY[]::TEXT[];

