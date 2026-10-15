-- CreateTable
CREATE TABLE "conversation_attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_attachments_key_key" ON "conversation_attachments"("key");

-- CreateIndex
CREATE INDEX "conversation_attachments_messageId_idx" ON "conversation_attachments"("messageId");

-- CreateIndex
CREATE INDEX "conversation_attachments_conversationId_idx" ON "conversation_attachments"("conversationId");

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

