import {Controller, Get, Middleware, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {ConversationSchemas, UtilitySchemas} from '@plunk/shared';

import {type EventStreamOptions, serveEventStream} from '../app/eventStream.js';
import {requireAuth, requireEmailVerified, requireSupportAgent} from '../middleware/auth.js';
import {ConversationService} from '../services/ConversationService.js';
import {Keys} from '../services/keys.js';
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
