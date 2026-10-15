import {CONTACT_IDENTITY_TYPES} from '@plunk/shared';
import signale from 'signale';

import {EXPO_ACCESS_TOKEN} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';
import {ContactService} from './ContactService.js';
import {ConversationService} from './ConversationService.js';
import type {MessengerSession} from './MessengerSessionService.js';
import {ProjectService} from './ProjectService.js';
import {QueueService} from './QueueService.js';

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push';
/** Devices a contact may keep registered; the least recently seen goes first. */
export const PUSH_TOKENS_PER_CONTACT = 10;
/** Expo asks senders to wait before reading receipts, which it keeps for a day. */
export const PUSH_RECEIPT_DELAY_MS = 15 * 60_000;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  details?: {error?: string};
}

/**
 * Pushes agent replies to the apps of signed-in contacts through Expo's push service. Tokens are
 * contact identities registered by the React Native SDK, so anonymizing a contact drops them with
 * the rest of its identities.
 */
export class ContactPushService {
  /** Only a verified session: an anonymous visitor's device must never receive a contact's replies. */
  public static async register(session: MessengerSession, token: string): Promise<void> {
    const contactId = this.verifiedContact(session);
    /* A token is one device, so a device that switches user moves to the new contact. */
    await ContactService.recordIdentity(session.projectId, contactId, CONTACT_IDENTITY_TYPES.PUSH_TOKEN, token);

    const stale = await prisma.contactIdentity.findMany({
      where: {projectId: session.projectId, contactId, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN},
      orderBy: {lastSeenAt: 'desc'},
      skip: PUSH_TOKENS_PER_CONTACT,
      select: {id: true},
    });
    if (stale.length > 0) {
      await prisma.contactIdentity.deleteMany({where: {id: {in: stale.map(row => row.id)}}});
    }
  }

  public static async unregister(session: MessengerSession, token: string): Promise<void> {
    const contactId = this.verifiedContact(session);
    await prisma.contactIdentity.deleteMany({
      where: {projectId: session.projectId, contactId, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN, value: token},
    });
  }

  /**
   * Throws only when nothing reached Expo, so a retry can't push twice. Conversations started by an
   * anonymous visitor are skipped even when merged into the contact: typing someone's email moves
   * a visitor's chat onto that contact, and its replies must not reach that person's phone.
   */
  public static async sendForMessage(messageId: string): Promise<{sent: number}> {
    const message = await prisma.conversationMessage.findUnique({
      where: {id: messageId},
      include: {
        authorUser: {select: {name: true, email: true}},
        attachments: {select: {filename: true}, take: 1},
        conversation: {select: {id: true, projectId: true, contactId: true, originVisitorId: true}},
      },
    });
    if (!message || message.authorType !== 'AGENT' || message.kind !== 'COMMENT') {
      return {sent: 0};
    }
    const {conversation} = message;
    if (conversation.originVisitorId !== null) {
      return {sent: 0};
    }
    const tokens = await prisma.contactIdentity.findMany({
      where: {projectId: conversation.projectId, contactId: conversation.contactId, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN},
      orderBy: {lastSeenAt: 'desc'},
      take: PUSH_TOKENS_PER_CONTACT,
      select: {value: true},
    });
    if (tokens.length === 0) {
      return {sent: 0};
    }

    const brand = await ProjectService.brand(conversation.projectId);
    const author = message.authorUser ? ConversationService.agentName(message.authorUser) : brand.name;
    const file = message.attachments[0];
    const preview = ConversationService.preview(message.body || (file ? `📎 ${file.filename}` : ''));
    const to = tokens.map(row => row.value);

    const response = await this.expo('send', {
      json: to.map(token => ({
        to: token,
        title: brand.name,
        body: `${author}: ${preview}`,
        sound: 'default',
        data: {plunk: {conversationId: conversation.id}},
      })),
    });
    if (!response) {
      return {sent: 0};
    }
    const tickets = (response as {data?: ExpoTicket[]}).data ?? [];

    const gone: string[] = [];
    const receipts: Record<string, string> = {};
    tickets.forEach((ticket, index) => {
      const token = to[index];
      if (!token) {
        return;
      }
      if (ticket.status === 'ok' && ticket.id) {
        receipts[ticket.id] = token;
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        gone.push(token);
      } else if (ticket.status === 'error') {
        signale.warn(`[CHAT-PUSH] Expo refused a push for message ${messageId}: ${ticket.details?.error ?? 'unknown error'}`);
      }
    });

    try {
      await this.forget(conversation.projectId, gone);
      if (Object.keys(receipts).length > 0) {
        await QueueService.queueChatNotification(
          {type: 'push_receipts', messageId, projectId: conversation.projectId, receipts},
          {delay: PUSH_RECEIPT_DELAY_MS},
        );
      }
    } catch (error) {
      signale.warn(`[CHAT-PUSH] Could not follow up the push for message ${messageId}:`, error);
    }
    return {sent: Object.keys(receipts).length};
  }

  /** A device that uninstalled the app or revoked permission is only reported in its receipt. */
  public static async checkReceipts(projectId: string, receipts: Record<string, string>): Promise<{removed: number}> {
    const response = await this.expo('getReceipts', {json: {ids: Object.keys(receipts)}});
    if (!response) {
      return {removed: 0};
    }
    const results = (response as {data?: Record<string, ExpoTicket>}).data ?? {};
    const gone = Object.entries(results)
      .filter(([, receipt]) => receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered')
      .map(([id]) => receipts[id])
      .filter((token): token is string => Boolean(token));
    await this.forget(projectId, gone);
    return {removed: gone.length};
  }

  private static verifiedContact(session: MessengerSession): string {
    if (!session.verified || !session.contactId) {
      throw new HttpException(403, 'Push notifications need a signed-in user', ErrorCode.FORBIDDEN);
    }
    return session.contactId;
  }

  private static async forget(projectId: string, tokens: string[]): Promise<void> {
    if (tokens.length > 0) {
      await prisma.contactIdentity.deleteMany({
        where: {projectId, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN, value: {in: tokens}},
      });
    }
  }

  /* Throws when Expo is unreachable or overloaded, so the job is retried. A request Expo rejects
  outright would be rejected again, so it is logged and dropped instead. */
  private static async expo(path: 'send' | 'getReceipts', {json}: {json: unknown}): Promise<unknown> {
    const response = await fetch(`${EXPO_PUSH_API}/${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(EXPO_ACCESS_TOKEN ? {Authorization: `Bearer ${EXPO_ACCESS_TOKEN}`} : {}),
      },
      body: JSON.stringify(json),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Expo push service answered ${response.status}`);
    }
    if (!response.ok) {
      signale.warn(`[CHAT-PUSH] Expo rejected ${path} with ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return null;
    }
    return response.json();
  }
}
