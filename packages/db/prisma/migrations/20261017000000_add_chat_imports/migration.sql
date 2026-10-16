-- CreateEnum
CREATE TYPE "ChatImportStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "importedFrom" TEXT;

-- CreateTable
CREATE TABLE "chat_imports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ChatImportStatus" NOT NULL DEFAULT 'RUNNING',
    "startedByUserId" TEXT,
    "totalContacts" INTEGER,
    "totalConversations" INTEGER,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipReasons" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "chat_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_imports_projectId_startedAt_idx" ON "chat_imports"("projectId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_projectId_importedFrom_key" ON "conversations"("projectId", "importedFrom");

-- AddForeignKey
ALTER TABLE "chat_imports" ADD CONSTRAINT "chat_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

