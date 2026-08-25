/**
 * Background Job: Sequence Delivery Sweep
 *
 * Sequences track per-contact progress as a sent-set (SequenceStepSend), not a
 * position pointer, so delivery is a pure sweep: every 5 minutes, for each
 * ACTIVE sequence, find each enrolled subscribed contact's lowest-order
 * published step missing from their sent-set and send it once the step's delay
 * since that contact's previous send (or enrollment) has elapsed.
 *
 * Correctness rests on three pieces implemented in SequenceService:
 * claim-then-send (an insert racing on the (sequenceStepId, contactId) unique
 * constraint), P2002-skip (a lost race means another run owns the send), and
 * stale-claim reaping (a crash between claim and send retries next run).
 * Concurrency 1 plus the fixed repeatable jobId makes overlap rare; the
 * constraint makes it harmless either way.
 */

import type {SequenceSweepJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {sequenceSweepQueue} from '../services/QueueService.js';
import {SequenceService} from '../services/SequenceService.js';

async function processSweep(job: Job<SequenceSweepJobData>) {
  const outcome = await SequenceService.sweepAllDue(job.data?.maxSends);

  if (outcome.sent > 0 || outcome.failed > 0) {
    signale.info(
      `[SEQUENCE-SWEEP] Sent ${outcome.sent} sequence email(s), ${outcome.failed} failed${outcome.capped ? ' (run capped)' : ''}`,
    );
  }

  return outcome;
}

export function createSequenceSweepWorker(): Worker<SequenceSweepJobData> {
  const worker = new Worker<SequenceSweepJobData>(sequenceSweepQueue.name, processSweep, {
    connection: sequenceSweepQueue.opts.connection,
    // One sweep at a time: overlapping runs would race on every due contact's
    // claim insert. The unique constraint keeps that safe, but it's pure
    // duplicated scanning.
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[SEQUENCE-SWEEP] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[SEQUENCE-SWEEP] Worker error:', error);
  });

  return worker;
}
