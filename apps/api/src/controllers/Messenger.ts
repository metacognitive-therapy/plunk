import {Controller, Get, Middleware, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {MessengerSchemas, UtilitySchemas} from '@plunk/shared';

import {type EventStreamOptions, serveEventStream} from '../app/eventStream.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';
import {chatAttachmentUpload} from '../middleware/attachmentUpload.js';
import {messengerSession, requireMessengerSession} from '../middleware/messenger.js';
import {ChatAttachmentService} from '../services/ChatAttachmentService.js';
import {ConversationService} from '../services/ConversationService.js';
import {MessengerContactService} from '../services/MessengerContactService.js';
import {Keys} from '../services/keys.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * The visitor-facing API used by the embedded messenger. Boot exchanges the project's public key
 * for a short-lived session token; every other route is authenticated by that token.
 */
@Controller('v1/messenger')
export class Messenger {
  public constructor(private readonly streamOptions: EventStreamOptions = {}) {}

  @Post('boot')
  @CatchAsync
  private async boot(req: Request, res: Response, _next: NextFunction) {
    const [scheme, publicKey] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !publicKey) {
      throw new HttpException(401, 'A public API key is required', ErrorCode.MISSING_AUTH);
    }

    const input = MessengerSchemas.boot.parse(req.body);
    const data = await ConversationService.boot(publicKey, input, req.get('origin'));
    return res.json({success: true, data});
  }

  @Get('stream')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async stream(req: Request, res: Response, _next: NextFunction) {
    const session = messengerSession(res);
    await serveEventStream(req, res, [Keys.Realtime.visitor(session.projectId, session.visitorId)], {
      ...this.streamOptions,
      expiresAt: session.expiresAt,
    });
  }

  @Post('email')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async email(req: Request, res: Response, _next: NextFunction) {
    const input = MessengerSchemas.captureEmail.parse(req.body);
    const data = await MessengerContactService.captureEmail(messengerSession(res), input);
    return res.json({success: true, data});
  }

  @Get('conversations')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async list(_req: Request, res: Response, _next: NextFunction) {
    const data = await ConversationService.listForSession(messengerSession(res));
    return res.json({success: true, data});
  }

  @Post('conversations')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async start(req: Request, res: Response, _next: NextFunction) {
    const {body} = MessengerSchemas.startConversation.parse(req.body);
    const data = await ConversationService.startConversation(messengerSession(res), body);
    return res.status(201).json({success: true, data});
  }

  @Get('conversations/:id')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async get(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const data = await ConversationService.getForSession(messengerSession(res), id);
    return res.json({success: true, data});
  }

  @Post('conversations/:id/messages')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async send(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {body} = MessengerSchemas.sendMessage.parse(req.body);
    const data = await ConversationService.sendFromContact(messengerSession(res), id, body);
    return res.status(201).json({success: true, data});
  }

  @Post('conversations/:id/attachments')
  @Middleware([requireMessengerSession, chatAttachmentUpload])
  @CatchAsync
  private async sendAttachment(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {body} = MessengerSchemas.sendAttachment.parse(req.body ?? {});
    const data = await ConversationService.sendAttachmentFromContact(messengerSession(res), id, req.file!, body);
    return res.status(201).json({success: true, data});
  }

  @Get('conversations/:id/attachments/:attachmentId')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async attachmentLink(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {id: attachmentId} = UtilitySchemas.id.parse({id: req.params.attachmentId});
    const data = await ChatAttachmentService.linkForSession(messengerSession(res), id, attachmentId);
    return res.json({success: true, data});
  }

  @Post('conversations/:id/typing')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async typing(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    await ConversationService.typingByContact(messengerSession(res), id);
    return res.status(204).end();
  }

  @Post('conversations/:id/read')
  @Middleware([requireMessengerSession])
  @CatchAsync
  private async read(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    await ConversationService.markReadByContact(messengerSession(res), id);
    return res.json({success: true});
  }
}
