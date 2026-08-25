/**
 * Background Job: Bulk Tag Action Processor
 * Processes bulk add/remove-tag operations across many contacts, mirroring
 * bulk-contact-processor.ts's two selection modes.
 */

import {Prisma} from '@plunk/db';
import type {BulkContactActionSelector, BulkTagActionJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {bulkTagQueue} from '../services/QueueService.js';
import {TagService} from '../services/TagService.js';

const BATCH_SIZE = 100;

interface BulkTagResult {
  action: 'add' | 'remove';
  totalRequested: number;
  successCount: number;
  unchangedCount: number;
  failureCount: number;
}

export function buildQueryWhere(projectId: string, selector: Extract<BulkContactActionSelector, {mode: 'query'}>): Prisma.ContactWhereInput {
  const search = selector.filter?.search;
  const subscribed = selector.filter?.subscribed;
  const tagIds = selector.filter?.tagIds ?? [];
  const excludeIds = selector.excludeIds ?? [];
  return {
    projectId,
    ...(search ? {email: {contains: search, mode: 'insensitive' as const}} : {}),
    ...(subscribed !== undefined ? {subscribed} : {}),
    ...(tagIds.length > 0 ? {contactTags: {some: {tagId: {in: tagIds}}}} : {}),
    ...(excludeIds.length > 0 ? {id: {notIn: excludeIds}} : {}),
  };
}

/**
 * Applies the tag action to each contact individually so one contact's
 * failure doesn't discard the tally for contacts already processed in the
 * same batch. Counts are per-contact (changed/unchanged/failed), not
 * per-(contact, tag) pair, so they line up with `totalRequested` (a contact
 * count) regardless of how many tagIds were requested.
 */
export async function applyBatch(
  projectId: string,
  action: 'add' | 'remove',
  tagIds: string[],
  contactIds: string[],
): Promise<{changed: number; unchanged: number; failed: number}> {
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const contactId of contactIds) {
    try {
      const result =
        action === 'add'
          ? await TagService.applyTags(projectId, contactId, tagIds)
          : await TagService.removeTags(projectId, contactId, tagIds);
      const tagsChanged = 'added' in result ? result.added : result.removed;
      if (tagsChanged > 0) {
        changed += 1;
      } else {
        unchanged += 1;
      }
    } catch (error) {
      signale.error(`[BULK-TAG-PROCESSOR] Failed to ${action} tags for contact ${contactId}:`, error);
      failed += 1;
    }
  }
  return {changed, unchanged, failed};
}

export function createBulkTagWorker() {
  const worker = new Worker<BulkTagActionJobData>(
    bulkTagQueue.name,
    async (job: Job<BulkTagActionJobData>) => {
      const {projectId, action, tagIds, selector} = job.data;

      const result: BulkTagResult = {
        action,
        totalRequested: 0,
        successCount: 0,
        unchangedCount: 0,
        failureCount: 0,
      };

      if (selector.mode === 'ids') {
        const {contactIds} = selector;
        result.totalRequested = contactIds.length;

        signale.info(
          `[BULK-TAG-PROCESSOR] Processing tag ${action} for ${contactIds.length} contacts (ids mode) in project ${projectId}`,
        );

        for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
          const batchIds = contactIds.slice(i, i + BATCH_SIZE);
          const {changed, unchanged, failed} = await applyBatch(projectId, action, tagIds, batchIds);
          result.successCount += changed;
          result.unchangedCount += unchanged;
          result.failureCount += failed;
          await job.updateProgress(Math.round(((i + batchIds.length) / contactIds.length) * 100));
        }
      } else {
        const where = buildQueryWhere(projectId, selector);
        const total = await prisma.contact.count({where});
        result.totalRequested = total;

        signale.info(
          `[BULK-TAG-PROCESSOR] Processing tag ${action} for ${total} contacts (query mode) in project ${projectId}`,
        );

        if (total === 0) {
          await job.updateProgress(100);
          return result;
        }

        let lastId: string | undefined;
        let processedRows = 0;
        const maxIterations = Math.ceil(total / BATCH_SIZE) + 50;

        for (let iter = 0; iter < maxIterations; iter += 1) {
          const batch = await prisma.contact.findMany({
            where: {
              ...where,
              ...(lastId ? {id: {...(where.id as object | undefined), lt: lastId}} : {}),
            },
            select: {id: true},
            orderBy: {id: 'desc'},
            take: BATCH_SIZE,
          });

          if (batch.length === 0) break;

          const batchIds = batch.map(c => c.id);
          lastId = batchIds[batchIds.length - 1];

          const {changed, unchanged, failed} = await applyBatch(projectId, action, tagIds, batchIds);
          result.successCount += changed;
          result.unchangedCount += unchanged;
          result.failureCount += failed;

          processedRows += batchIds.length;
          await job.updateProgress(Math.min(100, Math.round((processedRows / total) * 100)));

          if (batch.length < BATCH_SIZE) break;
        }
      }

      signale.info(
        `[BULK-TAG-PROCESSOR] Tag ${action} completed: ${result.successCount} succeeded, ${result.failureCount} failed`,
      );
      return result;
    },
    {
      connection: bulkTagQueue.opts.connection,
      concurrency: 3,
    },
  );

  worker.on('completed', job => {
    signale.info(`[BULK-TAG-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[BULK-TAG-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[BULK-TAG-PROCESSOR] Worker error:', err);
  });

  return worker;
}
