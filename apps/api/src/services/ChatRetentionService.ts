import {MESSENGER_RETENTION_DEFAULT_MONTHS} from '@plunk/shared';

import {prisma} from '../database/prisma.js';
import * as S3Service from './S3Service.js';

const BATCH_SIZE = 100;
const LEAD_INACTIVE_DAYS = 90;
const S3_PARALLEL = 8;
const BATCH_PAUSE_MS = 100;
/* Each batch holds row locks while its attachment objects are deleted, which is a network call per
conversation, so the transaction gets far longer than Prisma's 5 second default. */
const BATCH_TIMEOUT_MS = 120_000;

interface ConversationRef {
  id: string;
  projectId: string;
}

export interface ChatRetentionResult {
  conversations: number;
  leads: number;
}

/**
 * Erasure of live chat data: on anonymize, after the project's retention period, and for
 * messenger leads that never gave an email. Attachment objects are deleted before the rows, so a
 * failure leaves the rows in place for the next attempt instead of objects nobody can find.
 */
export class ChatRetentionService {
  public static async eraseForContacts(contactIds: string[]): Promise<number> {
    let erased = 0;
    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const conversations = await prisma.conversation.findMany({
        where: {contactId: {in: contactIds.slice(i, i + BATCH_SIZE)}},
        select: {id: true, projectId: true},
      });
      if (conversations.length === 0) continue;
      await this.deleteObjects(conversations);
      const {count} = await prisma.conversation.deleteMany({where: {id: {in: conversations.map(row => row.id)}}});
      erased += count;
    }
    return erased;
  }

  public static async sweep(options: {batchSize?: number} = {}): Promise<ChatRetentionResult> {
    const batchSize = options.batchSize ?? BATCH_SIZE;
    const conversations = await this.drain(() => this.deleteExpiredBatch(batchSize), batchSize);
    const leads = await this.drain(() => this.purgeLeadBatch(batchSize), batchSize);
    return {conversations, leads};
  }

  private static async drain(batch: () => Promise<{found: number; deleted: number}>, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const {found, deleted} = await batch();
      total += deleted;
      if (found < batchSize) return total;
      await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  }

  /* The shortest period in use bounds closedAt so the (status, closedAt) index is range-scanned;
  each project's own period is then applied per row. Month arithmetic is left to Postgres. */
  private static async deleteExpiredBatch(batchSize: number): Promise<{found: number; deleted: number}> {
    const [shortest] = await prisma.$queryRaw<{months: number}[]>`
      SELECT LEAST(COALESCE(MIN("retentionMonths"), ${MESSENGER_RETENTION_DEFAULT_MONTHS}), ${MESSENGER_RETENTION_DEFAULT_MONTHS})::int AS months
      FROM "messenger_settings"
    `;
    const months = shortest?.months ?? MESSENGER_RETENTION_DEFAULT_MONTHS;

    return prisma.$transaction(
      async tx => {
        /* FOR UPDATE re-checks the status of a row changed meanwhile, so a conversation a visitor
        reopened while the batch was read is skipped rather than deleted. */
        const rows = await tx.$queryRaw<ConversationRef[]>`
          SELECT c."id", c."projectId"
          FROM "conversations" c
          LEFT JOIN "messenger_settings" s ON s."projectId" = c."projectId"
          WHERE c."status" = 'CLOSED'
            AND c."closedAt" < now() - make_interval(months => ${months}::int)
            AND c."closedAt" < now() - make_interval(months => COALESCE(s."retentionMonths", ${MESSENGER_RETENTION_DEFAULT_MONTHS}::int))
          ORDER BY c."closedAt"
          LIMIT ${batchSize}
          FOR UPDATE OF c SKIP LOCKED
        `;
        if (rows.length === 0) return {found: 0, deleted: 0};

        await this.deleteObjects(rows);
        const {count} = await tx.conversation.deleteMany({where: {id: {in: rows.map(row => row.id)}}});
        return {found: rows.length, deleted: count};
      },
      {timeout: BATCH_TIMEOUT_MS},
    );
  }

  /*
   * A messenger lead is a contact with neither email nor external id that has conversations: the
   * messenger creates one on a visitor's first message, and an email-less contact made by tracking
   * has none. Candidates are found from the conversations table, never by scanning contacts.
   * Open and snoozed conversations of a dead lead go with it.
   */
  private static async purgeLeadBatch(batchSize: number): Promise<{found: number; deleted: number}> {
    const cutoff = new Date(Date.now() - LEAD_INACTIVE_DAYS * 24 * 60 * 60 * 1000);

    return prisma.$transaction(
      async tx => {
        const leads = await tx.$queryRaw<{id: string}[]>`
          SELECT ct."id"
          FROM "contacts" ct
          WHERE ct."id" IN (
              SELECT c."contactId" FROM "conversations" c
              GROUP BY c."contactId"
              HAVING MAX(c."lastMessageAt") < ${cutoff}
            )
            AND ct."email" IS NULL
            AND ct."externalId" IS NULL
            AND ct."deletedAt" IS NULL
            AND ct."updatedAt" < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM "contact_identities" i WHERE i."contactId" = ct."id" AND i."lastSeenAt" >= ${cutoff})
            AND NOT EXISTS (SELECT 1 FROM "events" e WHERE e."contactId" = ct."id" AND e."createdAt" >= ${cutoff})
            AND NOT EXISTS (SELECT 1 FROM "emails" m WHERE m."contactId" = ct."id")
          LIMIT ${batchSize}
          FOR UPDATE OF ct SKIP LOCKED
        `;
        if (leads.length === 0) return {found: 0, deleted: 0};

        /* A message written after the candidates were read updates its conversation, so the
        conversations are locked and checked again before anything is deleted. */
        const conversations = await tx.$queryRaw<(ConversationRef & {contactId: string; lastMessageAt: Date})[]>`
          SELECT "id", "projectId", "contactId", "lastMessageAt"
          FROM "conversations"
          WHERE "contactId" = ANY(${leads.map(lead => lead.id)}::text[])
          FOR UPDATE
        `;
        const active = new Set(conversations.filter(row => row.lastMessageAt >= cutoff).map(row => row.contactId));
        const purge = leads.map(lead => lead.id).filter(id => !active.has(id));

        await this.deleteObjects(conversations.filter(row => !active.has(row.contactId)));
        const {count} = await tx.contact.deleteMany({where: {id: {in: purge}}});
        return {found: leads.length, deleted: count};
      },
      {timeout: BATCH_TIMEOUT_MS},
    );
  }

  private static async deleteObjects(conversations: ConversationRef[]): Promise<void> {
    if (!S3Service.isS3Enabled() || conversations.length === 0) return;
    for (let i = 0; i < conversations.length; i += S3_PARALLEL) {
      await Promise.all(
        conversations
          .slice(i, i + S3_PARALLEL)
          .map(row => S3Service.deletePrivatePrefix(`${row.projectId}/${row.id}/`)),
      );
    }
  }
}
