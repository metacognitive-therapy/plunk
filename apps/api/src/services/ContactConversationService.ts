import type {Conversation, Prisma} from '@plunk/db';
import type {ContactConversations, ContactConversationSummary, InboxContactProfile} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {NotFound} from '../exceptions/index.js';
import {MembershipService} from './MembershipService.js';

const PROFILE_EVENTS = 10;
const PROFILE_SEGMENTS = 20;
const PROFILE_TAGS = 50;
const PROFILE_CONVERSATIONS = 10;
const CONTACT_CONVERSATIONS = 20;

type ConversationRow = Pick<
  Conversation,
  'id' | 'status' | 'channel' | 'createdAt' | 'lastMessageAt' | 'lastMessagePreview' | 'lastMessageAuthorType'
>;

const conversationColumns = {
  id: true,
  status: true,
  channel: true,
  createdAt: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  lastMessageAuthorType: true,
} satisfies Prisma.ConversationSelect;

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class ContactConversationService {
  /** Every list is bounded and fetched in one round of parallel queries, whatever the contact's history. */
  public static async profile(projectId: string, conversationId: string): Promise<InboxContactProfile> {
    const conversation = await prisma.conversation.findFirst({
      where: {id: conversationId, projectId},
      select: {
        contact: {
          select: {id: true, email: true, externalId: true, data: true, subscribed: true, createdAt: true},
        },
      },
    });
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }
    const {contact} = conversation;

    const [tags, memberships, events, others] = await Promise.all([
      prisma.contactTag.findMany({
        where: {contactId: contact.id},
        select: {tag: {select: {id: true, name: true}}},
        orderBy: {createdAt: 'asc'},
        take: PROFILE_TAGS,
      }),
      prisma.segmentMembership.findMany({
        where: {contactId: contact.id, exitedAt: null},
        select: {segment: {select: {id: true, name: true}}},
        orderBy: {enteredAt: 'desc'},
        take: PROFILE_SEGMENTS,
      }),
      prisma.event.findMany({
        where: {contactId: contact.id},
        select: {id: true, name: true, createdAt: true},
        orderBy: {createdAt: 'desc'},
        take: PROFILE_EVENTS,
      }),
      prisma.conversation.findMany({
        where: {contactId: contact.id, projectId, id: {not: conversationId}},
        select: conversationColumns,
        orderBy: {lastMessageAt: 'desc'},
        take: PROFILE_CONVERSATIONS,
      }),
    ]);

    return {
      id: contact.id,
      email: contact.email,
      externalId: contact.externalId,
      data: jsonObject(contact.data),
      subscribed: contact.subscribed,
      createdAt: contact.createdAt.toISOString(),
      tags: tags.map(row => row.tag),
      segments: memberships.map(row => row.segment),
      events: events.map(event => ({id: event.id, name: event.name, createdAt: event.createdAt.toISOString()})),
      conversations: others.map(row => this.toSummary(row, true)),
    };
  }

  /**
   * Members who can't use the Inbox still see that conversations exist, so they know to ask a
   * support agent, but never their text.
   */
  public static async forContact(
    projectId: string,
    contactId: string,
    userId: string | undefined,
  ): Promise<ContactConversations> {
    const [contact, membership] = await Promise.all([
      prisma.contact.findFirst({where: {id: contactId, projectId}, select: {id: true}}),
      userId ? MembershipService.getMembership(userId, projectId) : null,
    ]);
    if (!contact) {
      throw new NotFound('Contact', contactId);
    }
    const canOpen = membership ? MembershipService.isSupportAgent(membership) : false;

    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({
        where: {contactId, projectId},
        select: conversationColumns,
        orderBy: {lastMessageAt: 'desc'},
        take: CONTACT_CONVERSATIONS,
      }),
      prisma.conversation.count({where: {contactId, projectId}}),
    ]);

    return {canOpen, total, conversations: rows.map(row => this.toSummary(row, canOpen))};
  }

  private static toSummary(row: ConversationRow, withText: boolean): ContactConversationSummary {
    return {
      id: row.id,
      status: row.status,
      channel: row.channel,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessage:
        withText && row.lastMessagePreview !== null && row.lastMessageAuthorType !== null
          ? {body: row.lastMessagePreview, authorType: row.lastMessageAuthorType}
          : null,
    };
  }
}
