/**
 * Background Job: Bulk Sequence Enrollment Processor
 * Enrolls many contacts into a sequence, mirroring bulk-tag-processor.ts's two
 * selection modes. Enrollment is idempotent (skipDuplicates), so retries and
 * overlapping selections are safe.
 */

import type {BulkSequenceEnrollJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {bulkSequenceQueue} from '../services/QueueService.js';
import {SequenceService} from '../services/SequenceService.js';

import {buildQueryWhere} from './bulk-tag-processor.js';

const BATCH_SIZE = 100;

interface BulkSequenceEnrollResult {
  totalRequested: number;
  enrolledCount: number;
  skippedCount: number; // Already enrolled
}

export function createBulkSequenceWorker() {
  const worker = new Worker<BulkSequenceEnrollJobData>(
    bulkSequenceQueue.name,
    async (job: Job<BulkSequenceEnrollJobData>) => {
      const {projectId, sequenceId, selector} = job.data;

      const result: BulkSequenceEnrollResult = {
        totalRequested: 0,
        enrolledCount: 0,
        skippedCount: 0,
      };

      if (selector.mode === 'ids') {
        // Ids come from the dashboard/API; constrain them to the project so a
        // stale or crafted id never enrolls another project's contact.
        const contacts = await prisma.contact.findMany({
          where: {projectId, id: {in: selector.contactIds}},
          select: {id: true},
        });
        result.totalRequested = contacts.length;

        signale.info(
          `[BULK-SEQUENCE-PROCESSOR] Enrolling ${contacts.length} contacts (ids mode) into sequence ${sequenceId}`,
        );

        const ids = contacts.map(contact => contact.id);
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          const outcome = await SequenceService.enrollMany(projectId, sequenceId, batch);
          result.enrolledCount += outcome.enrolled;
          result.skippedCount += outcome.skipped;
          await job.updateProgress(Math.round(((i + batch.length) / ids.length) * 100));
        }
      } else {
        const where = buildQueryWhere(projectId, selector);
        const total = await prisma.contact.count({where});
        result.totalRequested = total;

        signale.info(
          `[BULK-SEQUENCE-PROCESSOR] Enrolling ${total} contacts (query mode) into sequence ${sequenceId}`,
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

          const outcome = await SequenceService.enrollMany(projectId, sequenceId, batchIds);
          result.enrolledCount += outcome.enrolled;
          result.skippedCount += outcome.skipped;

          processedRows += batchIds.length;
          await job.updateProgress(Math.min(100, Math.round((processedRows / total) * 100)));

          if (batch.length < BATCH_SIZE) break;
        }
      }

      signale.info(
        `[BULK-SEQUENCE-PROCESSOR] Enrollment completed: ${result.enrolledCount} enrolled, ${result.skippedCount} already enrolled`,
      );
      return result;
    },
    {
      connection: bulkSequenceQueue.opts.connection,
      concurrency: 3,
    },
  );

  worker.on('completed', job => {
    signale.info(`[BULK-SEQUENCE-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[BULK-SEQUENCE-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[BULK-SEQUENCE-PROCESSOR] Worker error:', err);
  });

  return worker;
}
