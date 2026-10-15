-- CreateEnum
CREATE TYPE "MessengerLauncherPosition" AS ENUM ('LEFT', 'RIGHT');

-- AlterTable
ALTER TABLE "messenger_settings" ADD COLUMN     "accentColor" TEXT NOT NULL DEFAULT '#111827',
ADD COLUMN     "greeting" TEXT,
ADD COLUMN     "launcherPosition" "MessengerLauncherPosition" NOT NULL DEFAULT 'RIGHT',
ADD COLUMN     "teamUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
