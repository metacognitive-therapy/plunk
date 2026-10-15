import {isSlackWebhookUrl} from '@plunk/shared';
import signale from 'signale';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';
import {ConversationService} from './ConversationService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {ProjectService} from './ProjectService.js';

const SLACK_TIMEOUT_MS = 5000;

interface SlackPayload {
  text: string;
  blocks?: unknown[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/* Visitor text is attacker-controlled: unescaped, "<!channel>" would ping the whole workspace. */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Notify-only Slack posts through a project's incoming webhook. A failing webhook is logged and
 * never retried: Slack may have accepted a post that timed out, and a retry would post it twice.
 */
export class SlackService {
  public static async notify(messageId: string): Promise<{posted: boolean}> {
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
      return {posted: false};
    }
    const {conversation} = message;
    const earlier = await prisma.conversationMessage.findFirst({
      where: {
        conversationId: conversation.id,
        authorType: 'CONTACT',
        kind: 'COMMENT',
        createdAt: {lt: message.createdAt},
      },
      select: {id: true},
    });
    const isNew = !earlier;
    if (!isNew && conversation.assigneeId) {
      return {posted: false};
    }
    const url = await MessengerSettingsService.slackWebhookUrl(conversation.projectId);
    if (!url) {
      return {posted: false};
    }

    const brand = await ProjectService.brand(conversation.projectId);
    const sender = ConversationService.contactLabel(conversation.contact);
    const file = message.attachments[0];
    const preview = ConversationService.preview(message.body || (file ? `📎 ${file.filename}` : '')) || 'No text';
    const title = `${isNew ? 'New conversation' : 'New reply'} from ${sender} · ${brand.name}`;
    const link = `${DASHBOARD_URI}${ConversationService.inboxPath(conversation.projectId, conversation.id)}`;

    const result = await this.post(url, {
      text: escapeMrkdwn(title),
      blocks: [
        {type: 'section', text: {type: 'mrkdwn', text: `*${escapeMrkdwn(title)}*`}},
        {type: 'section', text: {type: 'plain_text', text: preview, emoji: false}},
        {
          type: 'actions',
          elements: [{type: 'button', text: {type: 'plain_text', text: 'Open in Inbox'}, url: link}],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result.ok) {
      signale.warn(`[SLACK] Post for conversation ${conversation.id} failed: ${result.error}`);
    }
    return {posted: result.ok};
  }

  /** Sends a test post to the given webhook, or the saved one. Throws with Slack's answer on failure. */
  public static async test(projectId: string, url?: string | null): Promise<void> {
    const target = url ?? (await MessengerSettingsService.slackWebhookUrl(projectId));
    if (!target) {
      throw new HttpException(400, 'Add a Slack webhook URL first', ErrorCode.VALIDATION_ERROR);
    }
    const brand = await ProjectService.brand(projectId);
    const result = await this.post(target, {
      text: escapeMrkdwn(`Live chat notifications for ${brand.name} will be posted here.`),
    });
    if (!result.ok) {
      throw new HttpException(400, `Slack didn’t accept the test message (${result.error})`, ErrorCode.VALIDATION_ERROR);
    }
  }

  private static async post(url: string, payload: SlackPayload): Promise<{ok: true} | {ok: false; error: string}> {
    if (!isSlackWebhookUrl(url)) {
      return {ok: false, error: 'not a Slack webhook URL'};
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 100);
        return {ok: false, error: body ? `${response.status} ${body}` : String(response.status)};
      }
      return {ok: true};
    } catch (error) {
      return {ok: false, error: error instanceof Error ? error.message : 'request failed'};
    }
  }
}
