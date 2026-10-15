-- CreateTable
CREATE TABLE "conversation_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNorm" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_tag_assignments" (
    "conversationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_tag_assignments_pkey" PRIMARY KEY ("conversationId","tagId")
);

-- CreateTable
CREATE TABLE "saved_replies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tags_projectId_nameNorm_key" ON "conversation_tags"("projectId", "nameNorm");

-- CreateIndex
CREATE INDEX "conversation_tag_assignments_tagId_idx" ON "conversation_tag_assignments"("tagId");

-- CreateIndex
CREATE INDEX "saved_replies_projectId_title_idx" ON "saved_replies"("projectId", "title");

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tag_assignments" ADD CONSTRAINT "conversation_tag_assignments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tag_assignments" ADD CONSTRAINT "conversation_tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "conversation_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

