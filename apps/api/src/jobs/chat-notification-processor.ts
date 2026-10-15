/**
 * Background Job: Chat Notifications
 *
 * Delivers live chat notifications (mentions, new visitor messages and emailed replies) so the
 * request that wrote the message never waits on fan-out.
 */

import type {ChatNotificationJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {ChatNotificationService} from '../services/ChatNotificationService.js';
import {chatNotificationQueue} from '../services/QueueService.js';

export function createChatNotificationWorker(): Worker<ChatNotificationJobData> {
  const worker = new Worker<ChatNotificationJobData>(
    chatNotificationQueue.name,
    (job: Job<ChatNotificationJobData>) => ChatNotificationService.process(job.data),
    {connection: chatNotificationQueue.opts.connection, concurrency: 10},
  );

  worker.on('failed', (job, error) => {
    signale.error(`[CHAT-NOTIFICATION] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[CHAT-NOTIFICATION] Worker error:', error);
  });

  return worker;
}
