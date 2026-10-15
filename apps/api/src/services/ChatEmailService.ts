import {MESSAGE_BODY_MAX_LENGTH, formatFileSize} from '@plunk/shared';
import type {ParsedMail} from 'mailparser';
import signale from 'signale';

import {isTransactionallyMailableContact} from '../database/contact-filters.js';
import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {REPLY_ABOVE_MARKER, stripQuotedReply} from '../utils/replyText.js';
import {ChatAttachmentService, type IncomingFile} from './ChatAttachmentService.js';
import {ConversationService} from './ConversationService.js';
import {EmailService} from './EmailService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {ProjectService} from './ProjectService.js';

const REPLY_ADDRESS = /^reply\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([^@\s]+)$/i;
const MAX_MESSAGES_PER_EMAIL = 20;
const MAX_INBOUND_FILES = 10;

export interface InboundVerdicts {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isReplyAddress(recipient: string): boolean {
  return REPLY_ADDRESS.test(recipient.trim());
}

/**
 * The email side of a conversation: agent replies the visitor missed go out by email, and the
 * visitor's answer to that email comes back into the same conversation.
 */
export class ChatEmailService {
  /**
   * Emails every agent reply the visitor has not read yet, in one message. Runs when the delay
   * after an agent reply ends; later replies in the same burst find themselves already sent.
   */
  public static async sendUnread(messageId: string): Promise<{sent: number}> {
    const trigger = await prisma.conversationMessage.findUnique({
      where: {id: messageId},
      include: {conversation: {include: {contact: {select: {id: true, email: true, deletedAt: true, subscribed: true}}}}},
    });
    if (!trigger || trigger.authorType !== 'AGENT' || trigger.kind !== 'COMMENT' || trigger.emailedAt) {
      return {sent: 0};
    }
    const {conversation} = trigger;
    if (conversation.contactLastReadAt && conversation.contactLastReadAt >= trigger.createdAt) {
      return {sent: 0};
    }
    if (!isTransactionallyMailableContact(conversation.contact)) {
      return {sent: 0};
    }
    const settings = await MessengerSettingsService.get(conversation.projectId);
    if (!MessengerSettingsService.emailEnabled(settings)) {
      return {sent: 0};
    }

    /* Claimed before sending: the worker runs jobs concurrently, and two jobs of one burst must not
    both email the same replies. */
    const claimedAt = new Date();
    await prisma.conversationMessage.updateMany({
      where: {
        conversationId: conversation.id,
        authorType: 'AGENT',
        kind: 'COMMENT',
        emailedAt: null,
        createdAt: conversation.contactLastReadAt ? {gt: conversation.contactLastReadAt} : undefined,
      },
      data: {emailedAt: claimedAt},
    });
    const messages = await prisma.conversationMessage.findMany({
      where: {conversationId: conversation.id, emailedAt: claimedAt},
      include: {
        authorUser: {select: {name: true}},
        attachments: {select: {id: true, filename: true, size: true}, orderBy: {createdAt: 'asc'}},
      },
      orderBy: {createdAt: 'asc'},
      take: MAX_MESSAGES_PER_EMAIL,
    });
    if (messages.length === 0) {
      return {sent: 0};
    }

    const brand = await ProjectService.brand(conversation.projectId);
    const thread = `<conversation-${conversation.id}@${settings.replyDomain}>`;
    try {
      await EmailService.sendTransactionalEmail({
        projectId: conversation.projectId,
        contactId: conversation.contact.id,
        subject: `Your conversation with ${brand.name}`,
        body: this.render(brand, messages),
        from: settings.replyFromEmail,
        fromName: brand.name,
        replyTo: `reply+${conversation.replyToken}@${settings.replyDomain}`,
        headers: {'In-Reply-To': thread, References: thread},
      });
    } catch (error) {
      /* A billing limit or a contact who lost their address will not fix itself on retry. The
      replies stay in the messenger, so release them rather than mark them emailed. */
      await prisma.conversationMessage.updateMany({
        where: {id: {in: messages.map(message => message.id)}, emailedAt: claimedAt},
        data: {emailedAt: null},
      });
      if (error instanceof HttpException) {
        signale.warn(`[CHAT-EMAIL] Reply email for conversation ${conversation.id} not sent: ${error.message}`);
        return {sent: 0};
      }
      throw error;
    }
    return {sent: messages.length};
  }

  /**
   * Routes an inbound email addressed to a reply address. Returns false when the recipient is not
   * a reply address, so the caller handles it as ordinary inbound mail. A reply address is always
   * consumed here, even when its token is unknown: it must never reach the shared-domain fan-out.
   */
  public static async receive(recipient: string, parsed: ParsedMail | null, verdicts: InboundVerdicts): Promise<boolean> {
    const match = REPLY_ADDRESS.exec(recipient.trim());
    if (!match) {
      return false;
    }
    const token = match[1]!.toLowerCase();
    const domain = match[2]!.toLowerCase();

    const conversation = await prisma.conversation.findUnique({
      where: {replyToken: token},
      include: {contact: {select: {email: true}}},
    });
    if (!conversation || !parsed) {
      signale.info(`[CHAT-EMAIL] Dropped an email to an unknown or unreadable reply address on ${domain}`);
      return true;
    }
    const settings = await MessengerSettingsService.get(conversation.projectId);
    if (settings.replyDomain !== domain) {
      signale.info(`[CHAT-EMAIL] Dropped a reply for conversation ${conversation.id} sent to the wrong domain`);
      return true;
    }

    const sender = parsed.from?.value[0]?.address?.trim().toLowerCase();
    if (!sender) {
      return true;
    }

    const files: IncomingFile[] = [];
    const refused: string[] = [];
    for (const attachment of parsed.attachments) {
      if (attachment.related) {
        continue;
      }
      const file = {buffer: attachment.content, originalname: attachment.filename ?? 'file', size: attachment.size};
      try {
        ChatAttachmentService.inspect(file);
        if (files.length < MAX_INBOUND_FILES) {
          files.push(file);
        } else {
          refused.push(file.originalname);
        }
      } catch {
        refused.push(`${file.originalname} (${formatFileSize(file.size)})`);
      }
    }

    let body = stripQuotedReply(parsed.text ?? '');
    if (refused.length > 0) {
      body = `${body}\n\nNot attached: ${refused.join(', ')}`.trim();
    }
    body = body.slice(0, MESSAGE_BODY_MAX_LENGTH);
    if (!body && files.length === 0) {
      return true;
    }

    /* A From header is trivial to forge, so it only counts as the visitor when the receiving side
    could authenticate it. Anything else still reaches the agents, as a flagged note. */
    const authenticated = (verdicts.spf === 'PASS' || verdicts.dkim === 'PASS') && verdicts.dmarc !== 'FAIL';
    const fromContact = authenticated && sender === conversation.contact.email?.toLowerCase();

    await ConversationService.postFromEmail(conversation, {
      body,
      files,
      unverifiedSender: fromContact ? null : sender,
    });
    return true;
  }

  private static render(
    brand: {name: string; logoUrl: string | null},
    messages: {
      body: string;
      authorUser: {name: string | null} | null;
      attachments: {id: string; filename: string; size: number}[];
    }[],
  ): string {
    const muted = 'color:#6b7280;font-size:12px;';
    const parts = messages.map(message => {
      const author = escapeHtml(message.authorUser?.name?.trim() || brand.name);
      const text = message.body ? `<p style="margin:4px 0 0;white-space:pre-wrap;">${escapeHtml(message.body)}</p>` : '';
      const files = message.attachments
        .map(
          file =>
            `<li><a href="${escapeHtml(ChatAttachmentService.emailLink(file.id))}">${escapeHtml(file.filename)}</a> <span style="${muted}">${formatFileSize(file.size)}</span></li>`,
        )
        .join('');
      return `<div style="margin:0 0 20px;"><strong>${author}</strong>${text}${files ? `<ul style="margin:6px 0 0;padding-left:18px;">${files}</ul>` : ''}</div>`;
    });
    const logo = brand.logoUrl
      ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:40px;margin:0 0 16px;" />`
      : '';
    return [
      `<p style="${muted}">${REPLY_ABOVE_MARKER}</p>`,
      logo,
      ...parts,
      `<p style="${muted}">Reply to this email to answer. Your reply goes to the ${escapeHtml(brand.name)} team.</p>`,
    ].join('\n');
  }
}
