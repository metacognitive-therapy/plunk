import {pipeline} from 'node:stream/promises';

import {Controller, Get} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {isInlineImage, UtilitySchemas} from '@plunk/shared';

import {ChatAttachmentService} from '../services/ChatAttachmentService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Serves a chat attachment to whoever holds a signed link, which the messenger and Inbox APIs
 * issue only to the conversation's visitor or the project's support agents. The link carries the
 * authorization, so this route takes no session: an <img> cannot send one.
 */
@Controller('v1/chat-attachments')
export class ChatAttachments {
  @Get(':id/email')
  @CatchAsync
  private async fromEmail(req: Request, res: Response, _next: NextFunction) {
    const parsed = UtilitySchemas.id.safeParse(req.params);
    const link = parsed.success
      ? await ChatAttachmentService.redeemEmailLink(parsed.data.id, req.query.expires, req.query.signature)
      : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!link) {
      return res.status(404).type('text/plain').send('This file is no longer available');
    }
    return res.redirect(302, link.url);
  }

  @Get(':id')
  @CatchAsync
  private async download(req: Request, res: Response, _next: NextFunction) {
    const parsed = UtilitySchemas.id.safeParse(req.params);
    const remaining = parsed.success
      ? ChatAttachmentService.verify(parsed.data.id, req.query.expires, req.query.signature)
      : null;
    if (!parsed.success || remaining === null) {
      return res.status(403).type('text/plain').send('This link has expired or is not valid');
    }

    const file = await ChatAttachmentService.open(parsed.data.id);
    if (!file) {
      return res.status(404).type('text/plain').send('This file no longer exists');
    }

    const inline = isInlineImage(file.contentType);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.filename));
    res.setHeader('Cache-Control', `private, max-age=${remaining}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    await pipeline(file.body, res);
  }
}
