/**
 * Background Job: Snooze Sweep
 *
 * Every minute, reopens snoozed conversations whose snooze date has passed. Each wake is a
 * conditional update guarded on the snoozed state, so a run racing an agent's own change, or an
 * overlapping run, never wakes a conversation twice.
 */

import type {SnoozeSweepJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {ConversationService} from '../services/ConversationService.js';
import {snoozeSweepQueue} from '../services/QueueService.js';

async function processSweep(_job: Job<SnoozeSweepJobData>) {
  const woken = await ConversationService.wakeSnoozed();
  if (woken > 0) {
    signale.info(`[SNOOZE-SWEEP] Reopened ${woken} snoozed conversation(s)`);
  }
  return {woken};
}

export function createSnoozeSweepWorker(): Worker<SnoozeSweepJobData> {
  const worker = new Worker<SnoozeSweepJobData>(snoozeSweepQueue.name, processSweep, {
    connection: snoozeSweepQueue.opts.connection,
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[SNOOZE-SWEEP] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[SNOOZE-SWEEP] Worker error:', error);
  });

  return worker;
}
