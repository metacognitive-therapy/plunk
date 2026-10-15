/**
 * Background Job: Chat Retention
 *
 * Daily, deletes closed conversations past their project's retention period and messenger leads
 * that never gave an email and have been inactive for 90 days, with their attachment objects.
 */

import type {ChatRetentionJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {ChatRetentionService} from '../services/ChatRetentionService.js';
import {chatRetentionQueue} from '../services/QueueService.js';

async function processSweep(_job: Job<ChatRetentionJobData>) {
  const result = await ChatRetentionService.sweep();
  if (result.conversations > 0 || result.leads > 0) {
    signale.info(
      `[CHAT-RETENTION] Deleted ${result.conversations} expired conversation(s) and ${result.leads} inactive lead(s)`,
    );
  }
  return result;
}

export function createChatRetentionWorker(): Worker<ChatRetentionJobData> {
  const worker = new Worker<ChatRetentionJobData>(chatRetentionQueue.name, processSweep, {
    connection: chatRetentionQueue.opts.connection,
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[CHAT-RETENTION] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[CHAT-RETENTION] Worker error:', error);
  });

  return worker;
}
