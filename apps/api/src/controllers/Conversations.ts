import {Controller, Get, Middleware, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {ConversationSchemas, UtilitySchemas} from '@plunk/shared';

import {requireAuth, requireEmailVerified, requireSupportAgent} from '../middleware/auth.js';
import {ConversationService} from '../services/ConversationService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('conversations')
export class Conversations {
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
