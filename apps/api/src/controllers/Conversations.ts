import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {ConversationSchemas, UtilitySchemas} from '@plunk/shared';

import {type EventStreamOptions, serveEventStream} from '../app/eventStream.js';
import {chatAttachmentUpload} from '../middleware/attachmentUpload.js';
import {requireAuth, requireEmailVerified, requireSupportAgent} from '../middleware/auth.js';
import {ChatAttachmentService} from '../services/ChatAttachmentService.js';
import {ConversationService} from '../services/ConversationService.js';
import {ConversationTagService} from '../services/ConversationTagService.js';
import {Keys} from '../services/keys.js';
import {SavedReplyService} from '../services/SavedReplyService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('conversations')
export class Conversations {
  public constructor(private readonly streamOptions: EventStreamOptions = {}) {}

  @Get('stream')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async stream(req: Request, res: Response, _next: NextFunction) {
    await serveEventStream(req, res, [Keys.Realtime.project(res.locals.auth.projectId!)], this.streamOptions);
  }

  @Get('counts')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async counts(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const data = await ConversationService.counts(auth.projectId!, auth.userId!);
    return res.json({success: true, data});
  }

  @Get('agents')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async agents(req: Request, res: Response, _next: NextFunction) {
    const data = await ConversationService.agents(res.locals.auth.projectId!);
    return res.json({success: true, data});
  }

  @Get('tags')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async tags(_req: Request, res: Response, _next: NextFunction) {
    const data = await ConversationTagService.list(res.locals.auth.projectId!);
    return res.json({success: true, data});
  }

  @Post('tags')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async createTag(req: Request, res: Response, _next: NextFunction) {
    const {name} = ConversationSchemas.tag.parse(req.body);
    const data = await ConversationTagService.create(res.locals.auth.projectId!, name);
    return res.status(201).json({success: true, data});
  }

  @Patch('tags/:id')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async renameTag(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {name} = ConversationSchemas.tag.parse(req.body);
    const data = await ConversationTagService.rename(res.locals.auth.projectId!, id, name);
    return res.json({success: true, data});
  }

  @Delete('tags/:id')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async deleteTag(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    await ConversationTagService.remove(res.locals.auth.projectId!, id);
    return res.json({success: true});
  }

  @Get('saved-replies')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async savedReplies(_req: Request, res: Response, _next: NextFunction) {
    const data = await SavedReplyService.list(res.locals.auth.projectId!);
    return res.json({success: true, data});
  }

  @Post('saved-replies')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async createSavedReply(req: Request, res: Response, _next: NextFunction) {
    const input = ConversationSchemas.savedReply.parse(req.body);
    const data = await SavedReplyService.create(res.locals.auth.projectId!, input);
    return res.status(201).json({success: true, data});
  }

  @Patch('saved-replies/:id')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async updateSavedReply(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const input = ConversationSchemas.savedReplyUpdate.parse(req.body);
    const data = await SavedReplyService.update(res.locals.auth.projectId!, id, input);
    return res.json({success: true, data});
  }

  @Delete('saved-replies/:id')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async deleteSavedReply(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    await SavedReplyService.remove(res.locals.auth.projectId!, id);
    return res.json({success: true});
  }

  @Get('')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const options = ConversationSchemas.list.parse(req.query);
    const data = await ConversationService.list(auth.projectId!, auth.userId!, options);
    return res.json({success: true, data});
  }

  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const data = await ConversationService.get(auth.projectId!, auth.userId!, id);
    return res.json({success: true, data});
  }

  @Post(':id/messages')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async reply(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const {body} = ConversationSchemas.reply.parse(req.body);
    const data = await ConversationService.replyAsAgent(auth.projectId!, auth.userId!, id, body);
    return res.status(201).json({success: true, data});
  }

  @Post(':id/attachments')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent, chatAttachmentUpload])
  @CatchAsync
  private async replyWithAttachment(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const {body} = ConversationSchemas.replyAttachment.parse(req.body ?? {});
    const data = await ConversationService.replyWithAttachment(auth.projectId!, auth.userId!, id, req.file!, body);
    return res.status(201).json({success: true, data});
  }

  @Get(':id/attachments/:attachmentId')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async attachmentLink(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {id: attachmentId} = UtilitySchemas.id.parse({id: req.params.attachmentId});
    const data = await ChatAttachmentService.linkForAgent(res.locals.auth.projectId!, id, attachmentId);
    return res.json({success: true, data});
  }

  @Post(':id/notes')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async note(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const input = ConversationSchemas.note.parse(req.body);
    const data = await ConversationService.addNote(auth.projectId!, auth.userId!, id, input);
    return res.status(201).json({success: true, data});
  }

  @Post(':id/tags')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async applyTag(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {tagId} = ConversationSchemas.applyTag.parse(req.body);
    const data = await ConversationTagService.apply(res.locals.auth.projectId!, id, tagId);
    return res.json({success: true, data});
  }

  @Delete(':id/tags/:tagId')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async removeTag(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {tagId} = ConversationSchemas.applyTag.parse(req.params);
    const data = await ConversationTagService.unapply(res.locals.auth.projectId!, id, tagId);
    return res.json({success: true, data});
  }

  @Get(':id/saved-replies/:replyId')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async renderSavedReply(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {id: replyId} = UtilitySchemas.id.parse({id: req.params.replyId});
    const data = await SavedReplyService.render(res.locals.auth.projectId!, replyId, id);
    return res.json({success: true, data});
  }

  @Post(':id/status')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async status(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const change = ConversationSchemas.status.parse(req.body);
    const data = await ConversationService.setStatus(auth.projectId!, auth.userId!, id, change);
    return res.json({success: true, data});
  }

  @Post(':id/assignee')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async assign(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const {assigneeId} = ConversationSchemas.assign.parse(req.body);
    const data = await ConversationService.assign(auth.projectId!, auth.userId!, id, assigneeId);
    return res.json({success: true, data});
  }

  @Post(':id/typing')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async typing(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    await ConversationService.typingByAgent(auth.projectId!, auth.userId!, id);
    return res.status(204).end();
  }

  @Post(':id/read')
  @Middleware([requireAuth, requireEmailVerified, requireSupportAgent])
  @CatchAsync
  private async read(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    await ConversationService.markReadByAgent(auth.projectId!, auth.userId!, id);
    return res.json({success: true});
  }
}
