import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import {TagSchemas} from '@plunk/shared';
import type {BulkContactActionSelector} from '@plunk/types';
import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';

import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {QueueService} from '../services/QueueService.js';
import {TagService} from '../services/TagService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('tags')
export class Tags {
  /**
   * GET /tags
   * List all tags for the authenticated project
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const tags = await TagService.list(auth.projectId!);

    return res.status(200).json(tags);
  }

  /**
   * GET /tags/:id
   * Get a specific tag by ID
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const tagId = req.params.id;

    if (!tagId) {
      return res.status(400).json({error: 'Tag ID is required'});
    }

    const tag = await TagService.get(auth.projectId!, tagId);

    return res.status(200).json(tag);
  }

  /**
   * GET /tags/:id/contacts
   * Get contacts that have a tag
   */
  @Get(':id/contacts')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getContacts(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const tagId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);

    if (!tagId) {
      return res.status(400).json({error: 'Tag ID is required'});
    }

    const result = await TagService.getContacts(auth.projectId!, tagId, page, pageSize);

    return res.status(200).json(result);
  }

  /**
   * POST /tags
   * Create a new tag
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const parsed = TagSchemas.create.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid tag payload'});
    }

    const tag = await TagService.create(auth.projectId!, parsed.data.name);

    return res.status(201).json(tag);
  }

  /**
   * PATCH /tags/:id
   * Rename a tag
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const tagId = req.params.id;

    if (!tagId) {
      return res.status(400).json({error: 'Tag ID is required'});
    }

    const parsed = TagSchemas.update.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid tag payload'});
    }

    const tag = await TagService.rename(auth.projectId!, tagId, parsed.data.name);

    return res.status(200).json(tag);
  }

  /**
   * DELETE /tags/:id
   * Delete a tag (blocked if referenced by a campaign, workflow, or segment)
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const tagId = req.params.id;

    if (!tagId) {
      return res.status(400).json({error: 'Tag ID is required'});
    }

    await TagService.delete(auth.projectId!, tagId);

    return res.status(204).send();
  }

  /**
   * POST /tags/bulk-apply
   * Queue a bulk add/remove-tag operation across many contacts
   */
  @Post('bulk-apply')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkApply(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const parsed = TagSchemas.bulkApply.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: parsed.error.errors[0]?.message ?? 'Invalid bulk tag payload'});
    }

    const selector: BulkContactActionSelector =
      parsed.data.mode === 'ids'
        ? {mode: 'ids', contactIds: parsed.data.contactIds}
        : {mode: 'query', filter: parsed.data.filter, excludeIds: parsed.data.excludeIds};

    try {
      const job = await QueueService.queueBulkTagAction(auth.projectId!, selector, parsed.data.tagIds, parsed.data.action);
      return res.status(202).json({
        message: `Bulk tag ${parsed.data.action} queued successfully`,
        jobId: job.id,
      });
    } catch (error) {
      signale.error(`[TAGS] Failed to queue bulk ${parsed.data.action}:`, error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : `Failed to queue bulk ${parsed.data.action}`,
      });
    }
  }

  /**
   * GET /tags/bulk-apply/:jobId
   * Get bulk tag action job status
   */
  @Get('bulk-apply/:jobId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getBulkApplyStatus(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const jobId = req.params.jobId;

    if (!jobId) {
      return res.status(400).json({error: 'Job ID is required'});
    }

    try {
      const status = await QueueService.getBulkTagActionJobStatus(jobId, auth.projectId!);

      if (!status) {
        return res.status(404).json({error: 'Bulk tag action job not found'});
      }

      return res.status(200).json(status);
    } catch (error) {
      signale.error('[TAGS] Failed to get bulk tag action status:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get bulk tag action status',
      });
    }
  }

  /**
   * POST /tags/contacts/:contactId
   * Apply one or more tags to a single contact
   */
  @Post('contacts/:contactId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async applyToContact(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const contactId = req.params.contactId;
    const {tagIds} = req.body as {tagIds?: string[]};

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }
    if (!Array.isArray(tagIds) || tagIds.length === 0) {
      return res.status(400).json({error: 'tagIds must be a non-empty array'});
    }

    const result = await TagService.applyTags(auth.projectId!, contactId, tagIds);

    return res.status(200).json(result);
  }

  /**
   * DELETE /tags/contacts/:contactId
   * Remove one or more tags from a single contact
   */
  @Delete('contacts/:contactId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async removeFromContact(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const contactId = req.params.contactId;
    const {tagIds} = req.body as {tagIds?: string[]};

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }
    if (!Array.isArray(tagIds) || tagIds.length === 0) {
      return res.status(400).json({error: 'tagIds must be a non-empty array'});
    }

    const result = await TagService.removeTags(auth.projectId!, contactId, tagIds);

    return res.status(200).json(result);
  }
}
