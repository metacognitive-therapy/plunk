/**
 * Segment Count Update Worker
 * Processes segment count update jobs from the BullMQ queue
 */

import type {SegmentCountJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {NtfyService} from '../services/NtfyService.js';
import {segmentCountQueue} from '../services/QueueService.js';
import {SegmentService} from '../services/SegmentService.js';
import {TagService} from '../services/TagService.js';

/**
 * Process segments for a single project
 * - For segments with trackMembership: compute full membership and trigger events
 * - For segments without trackMembership: only update counts
 */
async function processProjectSegments(projectId: string, projectName?: string): Promise<void> {
  // Get all segments for this project, separating tracked vs non-tracked
  const segments = await prisma.segment.findMany({
    where: {projectId},
    select: {id: true, name: true, trackMembership: true},
  });

  const trackedSegments = segments.filter(s => s.trackMembership);
  const nonTrackedSegments = segments.filter(s => !s.trackMembership);

  // Process tracked segments with full membership computation (creates events)
  let updatedSegmentCount = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  if (trackedSegments.length > 0) {
    for (const segment of trackedSegments) {
      try {
        const result = await SegmentService.computeMembership(projectId, segment.id);

        // Track segments with actual changes for bundled notification
        if (result.added > 0 || result.removed > 0) {
          updatedSegmentCount++;
          totalAdded += result.added;
          totalRemoved += result.removed;
        }
      } catch (error) {
        signale.error(`[SEGMENT-COUNT-WORKER] Failed to compute membership for segment ${segment.id}:`, error);
        // Continue with other segments
      }
    }

    // Send bundled notification if there were any changes
    if (projectName && updatedSegmentCount > 0) {
      await NtfyService.notifySegmentMembershipBundled(
        projectName,
        projectId,
        updatedSegmentCount,
        totalAdded,
        totalRemoved,
      );
    }
  }

  // Process non-tracked segments with count-only update (lightweight)
  if (nonTrackedSegments.length > 0) {
    try {
      await SegmentService.refreshAllMemberCounts(projectId);
    } catch (error) {
      signale.error(`[SEGMENT-COUNT-WORKER] Failed to update counts for non-tracked segments:`, error);
    }
  }

  // Reconcile tag member counts (applyTags/removeTags increment/decrement
  // optimistically; this corrects any drift, same rationale as segment counts).
  try {
    await TagService.refreshAllMemberCounts(projectId);
  } catch (error) {
    signale.error(`[SEGMENT-COUNT-WORKER] Failed to update tag counts:`, error);
  }
}

/**
 * Process segment count update job
 */
async function processSegmentCountUpdate(job: Job<SegmentCountJobData>): Promise<void> {
  const {projectId} = job.data;

  try {
    if (projectId) {
      // Process specific project
      await processProjectSegments(projectId);
    } else {
      // Process all active projects
      const projects = await prisma.project.findMany({
        where: {disabled: false},
        select: {id: true, name: true},
      });

      signale.info(`[SEGMENT-COUNT-WORKER] Processing ${projects.length} active projects`);

      // Process projects in batches to avoid overwhelming the database
      const PROJECT_BATCH_SIZE = 10;
      for (let i = 0; i < projects.length; i += PROJECT_BATCH_SIZE) {
        const batch = projects.slice(i, i + PROJECT_BATCH_SIZE);

        await Promise.all(
          batch.map(async project => {
            try {
              await processProjectSegments(project.id, project.name);
            } catch (error) {
              signale.error(`[SEGMENT-COUNT-WORKER] Failed to process project ${project.id}:`, error);
              // Don't throw - continue with other projects
            }
          }),
        );

        // Small delay between project batches to avoid overwhelming the database
        if (i + PROJECT_BATCH_SIZE < projects.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  } catch (error) {
    signale.error(`[SEGMENT-COUNT-WORKER] Error processing job ${job.id}:`, error);
    throw error; // Re-throw to trigger retry
  }
}

/**
 * Create and export the segment count worker
 */
export function createSegmentCountWorker(): Worker {
  const worker = new Worker<SegmentCountJobData>(
    segmentCountQueue.name,
    async (job: Job<SegmentCountJobData>) => {
      await processSegmentCountUpdate(job);
    },
    {
      connection: segmentCountQueue.opts.connection,
      concurrency: 1, // Process one segment count job at a time to avoid database overload
      limiter: {
        max: 1, // Max 1 job per duration
        duration: 60000, // Per minute (prevents rapid-fire updates)
      },
    },
  );

  worker.on('failed', (job, error) => {
    signale.error(`[SEGMENT-COUNT-WORKER] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[SEGMENT-COUNT-WORKER] Worker error:', error);
  });

  return worker;
}
