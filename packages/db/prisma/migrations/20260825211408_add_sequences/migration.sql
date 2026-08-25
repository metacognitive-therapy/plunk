-- CreateEnum
CREATE TYPE "SequenceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "sequenceId" TEXT,
ADD COLUMN     "sequenceStepId" TEXT;

-- CreateTable
CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SequenceStatus" NOT NULL DEFAULT 'DRAFT',
    "type" "TemplateType" NOT NULL DEFAULT 'MARKETING',
    "from" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "enrollTagId" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_steps" (
    "id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sequenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_subscriptions" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_step_sends" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "sequenceStepId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "emailId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_step_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sequences_projectId_status_idx" ON "sequences"("projectId", "status");

-- CreateIndex
CREATE INDEX "sequences_enrollTagId_idx" ON "sequences"("enrollTagId");

-- CreateIndex
CREATE INDEX "sequence_steps_sequenceId_order_idx" ON "sequence_steps"("sequenceId", "order");

-- CreateIndex
CREATE INDEX "sequence_subscriptions_contactId_idx" ON "sequence_subscriptions"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_subscriptions_sequenceId_contactId_key" ON "sequence_subscriptions"("sequenceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_step_sends_emailId_key" ON "sequence_step_sends"("emailId");

-- CreateIndex
CREATE INDEX "sequence_step_sends_sequenceId_contactId_idx" ON "sequence_step_sends"("sequenceId", "contactId");

-- CreateIndex
CREATE INDEX "sequence_step_sends_contactId_idx" ON "sequence_step_sends"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_step_sends_sequenceStepId_contactId_key" ON "sequence_step_sends"("sequenceStepId", "contactId");

-- CreateIndex
CREATE INDEX "emails_sequenceId_idx" ON "emails"("sequenceId");

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_enrollTagId_fkey" FOREIGN KEY ("enrollTagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_subscriptions" ADD CONSTRAINT "sequence_subscriptions_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_subscriptions" ADD CONSTRAINT "sequence_subscriptions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_step_sends" ADD CONSTRAINT "sequence_step_sends_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_step_sends" ADD CONSTRAINT "sequence_step_sends_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "sequence_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_step_sends" ADD CONSTRAINT "sequence_step_sends_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_step_sends" ADD CONSTRAINT "sequence_step_sends_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
