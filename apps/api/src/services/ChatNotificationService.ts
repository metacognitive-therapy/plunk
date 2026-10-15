import {ChatUnreadEmail, isPlatformEmailEnabled, sendPlatformEmail} from '@plunk/email';
import type {AgentStreamEvent, ChatNotificationJobData, ChatPushPayload} from '@plunk/types';
import React from 'react';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ChatEmailService} from './ChatEmailService.js';
import {ContactPushService} from './ContactPushService.js';
import {ConversationService} from './ConversationService.js';
import {Keys} from './keys.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {ProjectService} from './ProjectService.js';
import {RealtimeHub} from './RealtimeHub.js';
import {SlackService} from './SlackService.js';
import {WebPushService} from './WebPushService.js';

const UNREAD_EMAIL_MAX_MESSAGES = 5;

/**
 * Fans chat notifications out to agents. Runs in the worker, never in the request that wrote the
 * message. Recipients are re-checked here, so someone who stopped being a support agent after the
 * message was written is not notified.
 */
export class ChatNotificationService {
  public static async process(
    job: ChatNotificationJobData,
  ): Promise<{notified: number} | {sent: number} | {posted: boolean} | {removed: number}> {
    switch (job.type) {
      case 'mention':
        return this.mention(job.messageId);
      case 'visitor_message':
        return this.visitorMessage(job.messageId);
      case 'reply_email':
        return ChatEmailService.sendUnread(job.messageId);
      case 'agent_email':
        return this.agentEmail(job.messageId);
      case 'slack':
        return SlackService.notify(job.messageId);
      case 'contact_push':
        return ContactPushService.sendForMessage(job.messageId);
      case 'push_receipts':
        return ContactPushService.checkReceipts(job.projectId, job.receipts);
    }
  }

  private static async mention(messageId: string): Promise<{notified: number}> {
    const message = await prisma.conversationMessage.findUnique({
      where: {id: messageId},
      include: {authorUser: {select: {id: true, name: true, email: true}}},
    });
    if (!message || message.kind !== 'NOTE' || !message.authorUser) {
      return {notified: 0};
    }

    const agentIds = new Set((await ConversationService.agents(message.projectId)).map(agent => agent.id));
    const recipients = message.mentionedUserIds.filter(id => id !== message.authorUserId && agentIds.has(id));

    const author = ConversationService.agentName(message.authorUser);
    const preview = ConversationService.preview(message.body);
    const event: AgentStreamEvent = {
      type: 'mention',
      projectId: message.projectId,
      conversationId: message.conversationId,
      messageId: message.id,
      author: {id: message.authorUser.id, name: author},
      preview,
    };
    await Promise.all(recipients.map(userId => RealtimeHub.publish(Keys.Realtime.user(userId), event)));
    await WebPushService.send(recipients, prefs => ({
      title: `${author} mentioned you`,
      body: prefs.pushPreview ? preview : 'Open the note in the Inbox',
      url: ConversationService.inboxPath(message.projectId, message.conversationId),
      tag: `mention-${message.id}`,
    }));
    return {notified: recipients.length};
  }

  /**
   * Every support agent's badge updates; the assignee, or every agent while unassigned, is alerted
   * with a sound and a push.
   */
  private static async visitorMessage(messageId: string): Promise<{notified: number}> {
    const message = await prisma.conversationMessage.findUnique({
      where: {id: messageId},
      include: {
        conversation: {
          select: {
            id: true,
            projectId: true,
            assigneeId: true,
            contact: {select: {email: true, externalId: true, data: true}},
          },
        },
        attachments: {select: {filename: true}, take: 1},
      },
    });
    if (!message || message.authorType !== 'CONTACT' || message.kind !== 'COMMENT') {
      return {notified: 0};
    }
    const {conversation} = message;

    const agentIds = (await ConversationService.agents(conversation.projectId)).map(agent => agent.id);
    const assignee = conversation.assigneeId && agentIds.includes(conversation.assigneeId) ? conversation.assigneeId : null;
    const alerted = assignee ? [assignee] : agentIds;

    await Promise.all(
      agentIds.map(userId =>
        RealtimeHub.publish(Keys.Realtime.user(userId), {
          type: 'visitor_message',
          projectId: conversation.projectId,
          conversationId: conversation.id,
          alert: alerted.includes(userId),
        } satisfies AgentStreamEvent),
      ),
    );

    const brand = await ProjectService.brand(conversation.projectId);
    const sender = ConversationService.contactLabel(conversation.contact);
    const file = message.attachments[0];
    const preview = ConversationService.preview(message.body || (file ? `📎 ${file.filename}` : ''));
    await WebPushService.send(
      alerted,
      (prefs): ChatPushPayload => ({
        title: prefs.pushPreview ? `${sender} · ${brand.name}` : `New message · ${brand.name}`,
        body: prefs.pushPreview ? preview : 'Open the conversation in the Inbox',
        url: ConversationService.inboxPath(conversation.projectId, conversation.id),
        tag: `conversation-${conversation.id}`,
      }),
    );
    return {notified: alerted.length};
  }

  /**
   * Emails the agents a visitor is waiting on, once the project's delay has passed with no agent
   * reading or answering. The claim on the conversation makes a burst of messages one email; an
   * agent reply or read clears it for the next burst.
   */
  private static async agentEmail(messageId: string): Promise<{sent: number}> {
    if (!isPlatformEmailEnabled()) {
      return {sent: 0};
    }
    const message = await prisma.conversationMessage.findUnique({
      where: {id: messageId},
      include: {
        conversation: {
          select: {
            id: true,
            projectId: true,
            status: true,
            assigneeId: true,
            agentsEmailedAt: true,
            contact: {select: {email: true, externalId: true, data: true}},
          },
        },
      },
    });
    if (!message || message.authorType !== 'CONTACT' || message.kind !== 'COMMENT') {
      return {sent: 0};
    }
    const {conversation} = message;
    if (conversation.status !== 'OPEN' || conversation.agentsEmailedAt) {
      return {sent: 0};
    }

    const agentIds = (await ConversationService.agents(conversation.projectId)).map(agent => agent.id);
    const assignee = conversation.assigneeId && agentIds.includes(conversation.assigneeId) ? conversation.assigneeId : null;
    const relevant = assignee ? [assignee] : agentIds;
    if (relevant.length === 0) {
      return {sent: 0};
    }
    const [read, answered, recipients] = await Promise.all([
      prisma.conversationRead.findFirst({
        where: {conversationId: conversation.id, userId: {in: relevant}, lastReadAt: {gte: message.createdAt}},
        select: {userId: true},
      }),
      prisma.conversationMessage.findFirst({
        where: {conversationId: conversation.id, authorType: 'AGENT', kind: 'COMMENT', createdAt: {gt: message.createdAt}},
        select: {id: true},
      }),
      prisma.user.findMany({where: {id: {in: relevant}, inboxEmail: true}, select: {email: true}}),
    ]);
    if (read || answered || recipients.length === 0) {
      return {sent: 0};
    }

    const {count} = await prisma.conversation.updateMany({
      where: {id: conversation.id, agentsEmailedAt: null},
      data: {agentsEmailedAt: new Date()},
    });
    if (count === 0) {
      return {sent: 0};
    }

    const [lastAnswer, lastRead] = await Promise.all([
      prisma.conversationMessage.findFirst({
        where: {conversationId: conversation.id, authorType: 'AGENT', kind: 'COMMENT'},
        orderBy: {createdAt: 'desc'},
        select: {createdAt: true},
      }),
      prisma.conversationRead.findFirst({
        where: {conversationId: conversation.id, userId: {in: relevant}},
        orderBy: {lastReadAt: 'desc'},
        select: {lastReadAt: true},
      }),
    ]);
    const seenUntil = [lastAnswer?.createdAt, lastRead?.lastReadAt].filter((date): date is Date => Boolean(date));
    const waiting = await prisma.conversationMessage.findMany({
      where: {
        conversationId: conversation.id,
        authorType: 'CONTACT',
        kind: 'COMMENT',
        createdAt: seenUntil.length ? {gt: new Date(Math.max(...seenUntil.map(date => date.getTime())))} : undefined,
      },
      orderBy: {createdAt: 'desc'},
      take: UNREAD_EMAIL_MAX_MESSAGES,
      include: {attachments: {select: {filename: true}, take: 1}},
    });

    const [brand, settings] = await Promise.all([
      ProjectService.brand(conversation.projectId),
      MessengerSettingsService.get(conversation.projectId),
    ]);
    const sender = ConversationService.contactLabel(conversation.contact);
    const template = React.createElement(ChatUnreadEmail, {
      sender,
      messages: waiting
        .reverse()
        .map(row => ConversationService.preview(row.body || (row.attachments[0] ? `📎 ${row.attachments[0].filename}` : ''))),
      minutes: settings.emailDelayMinutes,
      conversationUrl: `${DASHBOARD_URI}${ConversationService.inboxPath(conversation.projectId, conversation.id)}`,
      assignedToYou: Boolean(assignee),
      brand,
    });
    await Promise.all(
      recipients.map(recipient => sendPlatformEmail(recipient.email, `${sender} is waiting for a reply · ${brand.name}`, template)),
    );
    return {sent: recipients.length};
  }
}
