import type {AgentStreamEvent, ChatNotificationJobData} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {ChatEmailService} from './ChatEmailService.js';
import {ConversationService} from './ConversationService.js';
import {Keys} from './keys.js';
import {RealtimeHub} from './RealtimeHub.js';

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

    const event: AgentStreamEvent = {
      type: 'mention',
      projectId: message.projectId,
      conversationId: message.conversationId,
      messageId: message.id,
      author: {id: message.authorUser.id, name: ConversationService.agentName(message.authorUser)},
      preview: ConversationService.preview(message.body),
    };
    await Promise.all(recipients.map(userId => RealtimeHub.publish(Keys.Realtime.user(userId), event)));
    return {notified: recipients.length};
  }
}
