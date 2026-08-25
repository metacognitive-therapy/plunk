import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import {SequenceSchemas} from '@plunk/shared';
import type {BulkContactActionSelector} from '@plunk/types';
import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';

import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {QueueService} from '../services/QueueService.js';
import {SequenceService} from '../services/SequenceService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * Explicit id lists up to this size enroll synchronously; anything larger
 * (or any query-mode selector) goes through the bulk queue.
 */
const INLINE_ENROLL_LIMIT = 100;

@Controller('sequences')
export class Sequences {
  /**
   * GET /sequences
   * List all sequences for the authenticated project
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const sequences = await SequenceService.list(auth.projectId!);

    return res.status(200).json(sequences);
  }

  /**
   * GET /sequences/:id
   * Get a sequence with its steps in order
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const sequence = await SequenceService.get(auth.projectId!, sequenceId);

    return res.status(200).json(sequence);
  }

  /**
   * GET /sequences/:id/stats
   * Aggregate open/click stats, computed on demand from Email rows
   */
  @Get(':id/stats')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getStats(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const stats = await SequenceService.getStats(auth.projectId!, sequenceId);

    return res.status(200).json(stats);
  }

  /**
   * POST /sequences
   * Create a new sequence (starts as DRAFT)
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const parsed = SequenceSchemas.create.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid sequence payload'});
    }

    const sequence = await SequenceService.create(auth.projectId!, parsed.data);

    return res.status(201).json(sequence);
  }

  /**
   * PATCH /sequences/:id
   * Update sequence details or status (DRAFT / ACTIVE / PAUSED)
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const parsed = SequenceSchemas.update.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid sequence payload'});
    }

    const sequence = await SequenceService.update(auth.projectId!, sequenceId, parsed.data);

    return res.status(200).json(sequence);
  }

  /**
   * DELETE /sequences/:id
   * Delete a sequence (steps, subscriptions, and send records cascade)
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    await SequenceService.delete(auth.projectId!, sequenceId);

    return res.status(204).send();
  }

  /**
   * POST /sequences/:id/steps
   * Add a step (appended last, starts as a draft)
   */
  @Post(':id/steps')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async createStep(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const parsed = SequenceSchemas.createStep.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid step payload'});
    }

    const step = await SequenceService.createStep(auth.projectId!, sequenceId, parsed.data);

    return res.status(201).json(step);
  }

  /**
   * POST /sequences/:id/steps/reorder
   * Apply a full new step ordering
   */
  @Post(':id/steps/reorder')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async reorderSteps(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const parsed = SequenceSchemas.reorderSteps.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid reorder payload'});
    }

    await SequenceService.reorderSteps(auth.projectId!, sequenceId, parsed.data.stepIds);

    return res.status(200).json({success: true});
  }

  /**
   * PATCH /sequences/:id/steps/:stepId
   * Edit a step's content or delay (allowed at any time; publishing is separate)
   */
  @Patch(':id/steps/:stepId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async updateStep(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id: sequenceId, stepId} = req.params;

    if (!sequenceId || !stepId) {
      return res.status(400).json({error: 'Sequence ID and step ID are required'});
    }

    const parsed = SequenceSchemas.updateStep.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid step payload'});
    }

    const step = await SequenceService.updateStep(auth.projectId!, sequenceId, stepId, parsed.data);

    return res.status(200).json(step);
  }

  /**
   * POST /sequences/:id/steps/:stepId/publish
   * Publish a draft step (one-way): it becomes eligible on the next sweep
   */
  @Post(':id/steps/:stepId/publish')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async publishStep(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id: sequenceId, stepId} = req.params;

    if (!sequenceId || !stepId) {
      return res.status(400).json({error: 'Sequence ID and step ID are required'});
    }

    const step = await SequenceService.publishStep(auth.projectId!, sequenceId, stepId);

    return res.status(200).json(step);
  }

  /**
   * DELETE /sequences/:id/steps/:stepId
   * Delete a step (send records for it cascade away)
   */
  @Delete(':id/steps/:stepId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async deleteStep(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id: sequenceId, stepId} = req.params;

    if (!sequenceId || !stepId) {
      return res.status(400).json({error: 'Sequence ID and step ID are required'});
    }

    await SequenceService.deleteStep(auth.projectId!, sequenceId, stepId);

    return res.status(204).send();
  }

  /**
   * POST /sequences/:id/contacts
   * Enroll contacts. Small explicit id lists enroll synchronously (200 with
   * the outcome); larger lists and query-mode selectors are queued (202 with
   * a jobId to poll at GET /sequences/:id/contacts/:jobId).
   */
  @Post(':id/contacts')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async enroll(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const sequenceId = req.params.id;

    if (!sequenceId) {
      return res.status(400).json({error: 'Sequence ID is required'});
    }

    const parsed = SequenceSchemas.enroll.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid enrollment payload'});
    }

    if (parsed.data.mode === 'ids' && parsed.data.contactIds.length <= INLINE_ENROLL_LIMIT) {
      let outcome = {enrolled: 0, skipped: 0};
      for (const contactId of parsed.data.contactIds) {
        const result = await SequenceService.enroll(auth.projectId!, sequenceId, contactId);
        outcome = {enrolled: outcome.enrolled + result.enrolled, skipped: outcome.skipped + result.skipped};
      }
      return res.status(200).json(outcome);
    }

    // Validate existence and DRAFT rejection up front so the caller gets a
    // synchronous error instead of a silently failed job.
    await SequenceService.enrollMany(auth.projectId!, sequenceId, []);

    const selector: BulkContactActionSelector =
      parsed.data.mode === 'ids'
        ? {mode: 'ids', contactIds: parsed.data.contactIds}
        : {mode: 'query', filter: parsed.data.filter, excludeIds: parsed.data.excludeIds};

    try {
      const job = await QueueService.queueBulkSequenceEnroll(auth.projectId!, sequenceId, selector);
      return res.status(202).json({
        message: 'Bulk sequence enrollment queued successfully',
        jobId: job.id,
      });
    } catch (error) {
      signale.error('[SEQUENCES] Failed to queue bulk enrollment:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to queue bulk enrollment',
      });
    }
  }

  /**
   * GET /sequences/:id/contacts/:jobId
   * Get bulk enrollment job status
   */
  @Get(':id/contacts/:jobId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getEnrollStatus(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const jobId = req.params.jobId;

    if (!jobId) {
      return res.status(400).json({error: 'Job ID is required'});
    }

    try {
      const status = await QueueService.getBulkSequenceEnrollJobStatus(jobId, auth.projectId!);

      if (!status) {
        return res.status(404).json({error: 'Bulk enrollment job not found'});
      }

      return res.status(200).json(status);
    } catch (error) {
      signale.error('[SEQUENCES] Failed to get bulk enrollment status:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get bulk enrollment status',
      });
    }
  }

  /**
   * DELETE /sequences/:id/contacts/:contactId
   * Remove a contact from a sequence (their send records are wiped too)
   */
  @Delete(':id/contacts/:contactId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async unenroll(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id: sequenceId, contactId} = req.params;

    if (!sequenceId || !contactId) {
      return res.status(400).json({error: 'Sequence ID and contact ID are required'});
    }

    await SequenceService.unenroll(auth.projectId!, sequenceId, contactId);

    return res.status(204).send();
  }
}
