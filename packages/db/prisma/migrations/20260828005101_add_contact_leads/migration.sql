/*
  Warnings:

  - A unique constraint covering the columns `[projectId,externalId]` on the table `contacts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "externalId" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "contacts_projectId_externalId_key" ON "contacts"("projectId", "externalId");
