import type {AgentStreamEvent, ChatNotificationJobData, ChatPushPayload} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {ChatEmailService} from './ChatEmailService.js';
import {ConversationService} from './ConversationService.js';
import {Keys} from './keys.js';
import {ProjectService} from './ProjectService.js';
import {RealtimeHub} from './RealtimeHub.js';
import {WebPushService} from './WebPushService.js';

function inboxPath(projectId: string, conversationId: string): string {
  return `/inbox?${new URLSearchParams({project: projectId, view: 'all', c: conversationId})}`;
}

function contactLabel(contact: {email: string | null; externalId: string | null; data: unknown}): string {
  const data = (contact.data ?? {}) as Record<string, unknown>;
  const name = [data.firstName, data.lastName].filter(part => typeof part === 'string' && part).join(' ');
  return name || contact.email || contact.externalId || 'A visitor';
}

/**
 * Fans chat notifications out to agents. Runs in the worker, never in the request that wrote the
 * message. Recipients are re-checked here, so someone who stopped being a support agent after the
 * message was written is not notified.
 */
export class ChatNotificationService {
  public static async process(job: ChatNotificationJobData): Promise<{notified: number} | {sent: number}> {
    switch (job.type) {
      case 'mention':
        return this.mention(job.messageId);
      case 'visitor_message':
        return this.visitorMessage(job.messageId);
      case 'reply_email':
        return ChatEmailService.sendUnread(job.messageId);
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
      url: inboxPath(message.projectId, message.conversationId),
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
    const sender = contactLabel(conversation.contact);
    const file = message.attachments[0];
    const preview = ConversationService.preview(message.body || (file ? `📎 ${file.filename}` : ''));
    await WebPushService.send(
      alerted,
      (prefs): ChatPushPayload => ({
        title: prefs.pushPreview ? `${sender} · ${brand.name}` : `New message · ${brand.name}`,
        body: prefs.pushPreview ? preview : 'Open the conversation in the Inbox',
        url: inboxPath(conversation.projectId, conversation.id),
        tag: `conversation-${conversation.id}`,
      }),
    );
    return {notified: alerted.length};
  }
}
