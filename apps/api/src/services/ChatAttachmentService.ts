import crypto from 'node:crypto';
import type {Readable} from 'node:stream';

import {CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_TYPES} from '@plunk/shared';
import type {ChatAttachmentLink} from '@plunk/types';

import {API_URI, JWT_SECRET} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException, NotFound} from '../exceptions/index.js';
import {MessengerContactService} from './MessengerContactService.js';
import type {MessengerSession} from './MessengerSessionService.js';
import * as S3Service from './S3Service.js';

export const ATTACHMENT_LINK_TTL_SECONDS = 5 * 60;
/* An emailed reply may be opened weeks later. Its link only redirects to a fresh short one, after
re-checking that the file still exists and still belongs to a visible message. */
export const ATTACHMENT_EMAIL_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

const FILENAME_MAX_LENGTH = 200;

const SIGNATURES: Record<string, Buffer[]> = {
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  'image/webp': [Buffer.from('RIFF')],
  'application/pdf': [Buffer.from('%PDF-')],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
};

const TEXT_TYPES = new Set(['text/plain', 'text/csv']);

const EXTENSION_TYPES = new Map(
  Object.entries(CHAT_ATTACHMENT_TYPES).flatMap(([type, extensions]) => extensions.map(ext => [ext, type] as const)),
);

const signingKey = crypto.createHmac('sha256', JWT_SECRET).update('chat-attachment-link').digest();
const emailSigningKey = crypto.createHmac('sha256', JWT_SECRET).update('chat-attachment-email-link').digest();

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface StoredAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

export class ChatAttachmentService {
  /**
   * The type is derived from the extension and then proven by the content, so neither a renamed
   * executable nor a browser's guess at the MIME type decides what is stored.
   */
  public static inspect(file: IncomingFile): {filename: string; contentType: string} {
    if (file.size === 0) {
      throw new HttpException(400, 'The file is empty', ErrorCode.BAD_REQUEST);
    }
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new HttpException(413, 'Files can be up to 10 MB', ErrorCode.BAD_REQUEST);
    }

    const filename = this.cleanFilename(file.originalname);
    const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
    const contentType = EXTENSION_TYPES.get(extension);
    if (!contentType) {
      throw new HttpException(415, 'This type of file can’t be sent', ErrorCode.BAD_REQUEST);
    }

    const matches = TEXT_TYPES.has(contentType)
      ? !file.buffer.subarray(0, 8192).includes(0)
      : (SIGNATURES[contentType] ?? []).some(signature => file.buffer.subarray(0, signature.length).equals(signature));
    if (!matches) {
      throw new HttpException(415, 'The file’s contents don’t match its type', ErrorCode.BAD_REQUEST);
    }

    return {filename, contentType};
  }

  public static async store(projectId: string, conversationId: string, file: IncomingFile): Promise<StoredAttachment> {
    if (!S3Service.isS3Enabled()) {
      throw new HttpException(503, 'File sharing is not set up on this server', ErrorCode.EXTERNAL_SERVICE_ERROR);
    }
    const {filename, contentType} = this.inspect(file);
    const key = `${projectId}/${conversationId}/${crypto.randomUUID()}`;
    await S3Service.putPrivateObject(key, file.buffer, contentType);
    return {key, filename, contentType, size: file.size};
  }

  /** Best effort: an orphaned object is harmless and is removed with its project or contact. */
  public static async discard(key: string): Promise<void> {
    await S3Service.deletePrivateObjects([key]).catch(() => undefined);
  }

  public static async linkForSession(
    session: MessengerSession,
    conversationId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentLink> {
    const attachment = await prisma.conversationAttachment.findFirst({
      where: {
        id: attachmentId,
        conversationId,
        projectId: session.projectId,
        message: {kind: 'COMMENT', conversation: MessengerContactService.conversationScope(session)},
      },
      select: {id: true},
    });
    if (!attachment) {
      throw new NotFound('Attachment', attachmentId);
    }
    return this.link(attachment.id);
  }

  public static async linkForAgent(
    projectId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentLink> {
    const attachment = await prisma.conversationAttachment.findFirst({
      where: {id: attachmentId, conversationId, projectId},
      select: {id: true},
    });
    if (!attachment) {
      throw new NotFound('Attachment', attachmentId);
    }
    return this.link(attachment.id);
  }

  public static link(attachmentId: string, now: number = Date.now()): ChatAttachmentLink {
    const expires = Math.floor(now / 1000) + ATTACHMENT_LINK_TTL_SECONDS;
    const url = new URL(`/v1/chat-attachments/${attachmentId}`, API_URI);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', this.sign(attachmentId, expires));
    return {url: url.toString(), expiresAt: new Date(expires * 1000).toISOString()};
  }

  /** Returns the seconds the link has left, or null when it is forged or expired. */
  public static verify(attachmentId: string, expires: unknown, signature: unknown): number | null {
    return this.check(signingKey, ATTACHMENT_LINK_TTL_SECONDS, attachmentId, expires, signature);
  }

  public static emailLink(attachmentId: string, now: number = Date.now()): string {
    const expires = Math.floor(now / 1000) + ATTACHMENT_EMAIL_LINK_TTL_SECONDS;
    const url = new URL(`/v1/chat-attachments/${attachmentId}/email`, API_URI);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', this.sign(attachmentId, expires, emailSigningKey));
    return url.toString();
  }

  /** Swaps a valid email link for a fresh short one, or null when the link or the file is gone. */
  public static async redeemEmailLink(
    attachmentId: string,
    expires: unknown,
    signature: unknown,
  ): Promise<ChatAttachmentLink | null> {
    if (this.check(emailSigningKey, ATTACHMENT_EMAIL_LINK_TTL_SECONDS, attachmentId, expires, signature) === null) {
      return null;
    }
    const attachment = await prisma.conversationAttachment.findFirst({
      where: {id: attachmentId, message: {kind: 'COMMENT'}},
      select: {id: true},
    });
    return attachment ? this.link(attachment.id) : null;
  }

  public static async open(
    attachmentId: string,
  ): Promise<{filename: string; contentType: string; size: number; body: Readable} | null> {
    const attachment = await prisma.conversationAttachment.findUnique({where: {id: attachmentId}});
    if (!attachment) {
      return null;
    }
    const body = await S3Service.getPrivateObject(attachment.key);
    return body ? {filename: attachment.filename, contentType: attachment.contentType, size: attachment.size, body} : null;
  }

  private static check(
    key: Buffer,
    ttlSeconds: number,
    attachmentId: string,
    expires: unknown,
    signature: unknown,
  ): number | null {
    if (typeof expires !== 'string' || typeof signature !== 'string' || !/^\d{1,12}$/.test(expires)) {
      return null;
    }
    const remaining = Number(expires) - Math.floor(Date.now() / 1000);
    if (remaining <= 0 || remaining > ttlSeconds) {
      return null;
    }
    const expected = Buffer.from(this.sign(attachmentId, Number(expires), key));
    const given = Buffer.from(signature);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? remaining : null;
  }

  private static sign(attachmentId: string, expires: number, key: Buffer = signingKey): string {
    return crypto.createHmac('sha256', key).update(`${attachmentId}.${expires}`).digest('base64url');
  }

  private static cleanFilename(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
    if (!cleaned) {
      return 'file';
    }
    if (cleaned.length <= FILENAME_MAX_LENGTH) {
      return cleaned;
    }
    const dot = cleaned.lastIndexOf('.');
    const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
    return cleaned.slice(0, FILENAME_MAX_LENGTH - extension.length) + extension;
  }
}
