import {
  type Conversation,
  type ConversationMessage,
  type MessageAuthorType,
  type MessageKind,
  type MessageSource,
  Prisma,
} from '@plunk/db';
import {CONTACT_IDENTITY_TYPES, type ConversationView, normalizeOrigin, resolveBrand} from '@plunk/shared';
import type {
  InboxConversation,
  InboxStreamEvent,
  InboxConversationSummary,
  InboxMessage,
  InboxPage,
  MessengerBootResponse,
  MessengerConversation,
  MessengerConversationSummary,
  MessengerMessage,
  MessengerStartResponse,
  MessengerStreamEvent,
} from '@plunk/types';

import {API_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {ErrorCode, HttpException, NotFound} from '../exceptions/index.js';
import {Keys} from './keys.js';
import {type MessengerSession, MessengerSessionService} from './MessengerSessionService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {ProjectService} from './ProjectService.js';
import {RealtimeHub} from './RealtimeHub.js';

const PREVIEW_LENGTH = 140;
const MESSENGER_HISTORY_LIMIT = 20;
/* A thread is loaded whole up to this many messages; older ones are dropped from the view rather
than paginated, which is fine for support threads and keeps the read a single indexed query. */
const THREAD_MESSAGE_LIMIT = 200;

const API_ORIGIN = normalizeOrigin(API_URI);
/* Clients send typing at most every few seconds; this caps what a misbehaving one can publish. */
const TYPING_THROTTLE_MS = 2000;

const authorSelect = {select: {id: true, name: true, email: true}} as const;

type MessageWithAuthor = ConversationMessage & {authorUser: {id: string; name: string | null; email: string} | null};

interface PostMessageInput {
  authorType: MessageAuthorType;
  authorUserId?: string | null;
  kind?: MessageKind;
  body: string;
  source: MessageSource;
}

export class ConversationService {

  /**
   * Starts a messenger session. Never creates a contact: a visitor who only opens the messenger
   * must not become a lead, so the contact is created when the first message is sent.
   */
  public static async boot(
    publicKey: string,
    input: {visitorId: string; parentOrigin?: string},
    requestOrigin: string | undefined,
  ): Promise<MessengerBootResponse> {
    const project = await ProjectService.public(publicKey);
    if (!project) {
      throw new HttpException(401, 'Invalid public API key', ErrorCode.INVALID_API_KEY);
    }
    if (project.disabled) {
      throw new HttpException(403, 'This project has been disabled', ErrorCode.PROJECT_DISABLED);
    }

    const settings = await MessengerSettingsService.get(project.id);
    if (!settings.enabled || settings.allowedOrigins.length === 0) {
      throw new HttpException(403, 'The messenger is not enabled for this project', ErrorCode.FORBIDDEN);
    }

    /* The frame is served from the API origin, so a request from the frame carries the API origin.
    Any other origin means a third-party page is calling the API directly and must be allowlisted. */
    const origin = requestOrigin ? normalizeOrigin(requestOrigin) : null;
    if (requestOrigin && origin !== API_ORIGIN && !(origin && MessengerSettingsService.isOriginAllowed(settings, origin))) {
      throw new HttpException(403, 'This website is not allowed to use the messenger', ErrorCode.FORBIDDEN);
    }

    if (input.parentOrigin) {
      const parent = normalizeOrigin(input.parentOrigin);
      if (!parent || !MessengerSettingsService.isOriginAllowed(settings, parent)) {
        throw new HttpException(403, 'This website is not allowed to use the messenger', ErrorCode.FORBIDDEN);
      }
    }

    const identity = await prisma.contactIdentity.findUnique({
      where: {
        projectId_type_value: {projectId: project.id, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: input.visitorId},
      },
      select: {contactId: true},
    });

    const {token, expiresAt} = MessengerSessionService.sign({
      projectId: project.id,
      visitorId: input.visitorId,
      contactId: identity?.contactId ?? null,
      verified: false,
    });

    const brand = resolveBrand(project);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      project: {name: brand.name, logoUrl: brand.logoUrl, language: project.language},
      appearance: await MessengerSettingsService.appearance(project.id, settings),
    };
  }

  public static async startConversation(session: MessengerSession, body: string): Promise<MessengerStartResponse> {
    const contactId = await this.resolveVisitorContact(session);

    const conversation = await prisma.conversation.create({
      data: {
        projectId: session.projectId,
        contactId,
        channel: 'WIDGET',
        originVisitorId: session.visitorId,
      },
    });
    await this.postMessage(conversation, {authorType: 'CONTACT', body, source: 'WIDGET'});

    const {token, expiresAt} = MessengerSessionService.sign({...session, contactId});
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      conversation: await this.getForSession(session, conversation.id),
    };
  }

  public static async listForSession(session: MessengerSession): Promise<MessengerConversationSummary[]> {
    const conversations = await prisma.conversation.findMany({
      where: {projectId: session.projectId, originVisitorId: session.visitorId},
      orderBy: {lastMessageAt: 'desc'},
      take: MESSENGER_HISTORY_LIMIT,
    });

    return conversations.map(conversation => ({
      id: conversation.id,
      status: conversation.status,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      lastMessage:
        conversation.lastMessagePreview !== null && conversation.lastMessageAuthorType !== null
          ? {body: conversation.lastMessagePreview, authorType: conversation.lastMessageAuthorType}
          : null,
      unread: this.isUnreadByContact(conversation),
    }));
  }

  public static async getForSession(session: MessengerSession, conversationId: string): Promise<MessengerConversation> {
    const conversation = await this.requireSessionConversation(session, conversationId);
    const messages = await this.loadThread(conversation.id, {kind: 'COMMENT'});

    return {
      id: conversation.id,
      status: conversation.status,
      messages: messages.map(message => this.toMessengerMessage(message)),
    };
  }

  public static async sendFromContact(
    session: MessengerSession,
    conversationId: string,
    body: string,
  ): Promise<MessengerMessage> {
    const conversation = await this.requireSessionConversation(session, conversationId);
    const message = await this.postMessage(conversation, {authorType: 'CONTACT', body, source: 'WIDGET'});
    return this.toMessengerMessage(message);
  }

  public static async markReadByContact(session: MessengerSession, conversationId: string): Promise<void> {
    const conversation = await this.requireSessionConversation(session, conversationId);
    if (!this.isUnreadByContact(conversation)) {
      return;
    }
    const readAt = new Date();
    await prisma.conversation.update({where: {id: conversation.id}, data: {contactLastReadAt: readAt}});
    await this.publishToInbox(conversation.projectId, {
      type: 'read',
      conversationId: conversation.id,
      reader: {type: 'CONTACT', readAt: readAt.toISOString()},
    });
  }

  public static async typingByContact(session: MessengerSession, conversationId: string): Promise<void> {
    const conversation = await this.requireSessionConversation(session, conversationId);
    if (await this.claimTypingSlot(conversation.id, 'contact')) {
      await this.publishToInbox(conversation.projectId, {
        type: 'typing',
        conversationId: conversation.id,
        author: {type: 'CONTACT'},
      });
    }
  }

  public static async list(
    projectId: string,
    userId: string,
    options: {view: ConversationView; cursor?: string; limit: number},
  ): Promise<InboxPage> {
    const where: Prisma.ConversationWhereInput = {projectId, ...this.viewFilter(options.view, userId)};

    if (options.cursor) {
      const cursor = this.decodeCursor(options.cursor);
      where.OR = [
        {lastMessageAt: {lt: cursor.lastMessageAt}},
        {lastMessageAt: cursor.lastMessageAt, id: {lt: cursor.id}},
      ];
    }

    const rows = await prisma.conversation.findMany({
      where,
      orderBy: [{lastMessageAt: 'desc'}, {id: 'desc'}],
      take: options.limit + 1,
      include: {contact: {select: {id: true, email: true, externalId: true, data: true}}},
    });

    const page = rows.slice(0, options.limit);
    const reads = await this.readsFor(
      userId,
      page.map(row => row.id),
    );

    const last = page[page.length - 1];
    return {
      conversations: page.map(row => this.toInboxSummary(row, reads.get(row.id))),
      nextCursor: rows.length > options.limit && last ? this.encodeCursor(last) : null,
    };
  }

  public static async get(projectId: string, userId: string, conversationId: string): Promise<InboxConversation> {
    const conversation = await prisma.conversation.findFirst({
      where: {id: conversationId, projectId},
      include: {contact: {select: {id: true, email: true, externalId: true, data: true}}},
    });
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }

    const [messages, reads] = await Promise.all([
      this.loadThread(conversation.id),
      this.readsFor(userId, [conversation.id]),
    ]);

    return {
      ...this.toInboxSummary(conversation, reads.get(conversation.id)),
      channel: conversation.channel,
      snoozedUntil: conversation.snoozedUntil?.toISOString() ?? null,
      contactLastReadAt: conversation.contactLastReadAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      messages: messages.map(message => this.toInboxMessage(message)),
    };
  }

  public static async replyAsAgent(
    projectId: string,
    userId: string,
    conversationId: string,
    body: string,
  ): Promise<InboxMessage> {
    const conversation = await this.requireProjectConversation(projectId, conversationId);
    const message = await this.postMessage(conversation, {
      authorType: 'AGENT',
      authorUserId: userId,
      body,
      source: 'DASHBOARD',
    });
    await this.markReadByAgent(projectId, userId, conversationId);
    return this.toInboxMessage(message);
  }

  public static async markReadByAgent(projectId: string, userId: string, conversationId: string): Promise<void> {
    await this.requireProjectConversation(projectId, conversationId);
    const now = new Date();
    await prisma.conversationRead.upsert({
      where: {userId_conversationId: {userId, conversationId}},
      create: {userId, conversationId, lastReadAt: now},
      update: {lastReadAt: now},
    });
    await this.publishToInbox(projectId, {type: 'read', conversationId, reader: {type: 'AGENT', userId}});
  }

  public static async typingByAgent(projectId: string, userId: string, conversationId: string): Promise<void> {
    const conversation = await this.requireProjectConversation(projectId, conversationId);
    if (!(await this.claimTypingSlot(conversation.id, userId))) {
      return;
    }
    const user = await prisma.user.findUnique({where: {id: userId}, select: {name: true, email: true}});
    const visibleName = user?.name?.trim() || null;
    await Promise.all([
      this.publishToInbox(projectId, {
        type: 'typing',
        conversationId,
        author: {type: 'AGENT', userId, name: user ? this.agentName(user) : 'Support'},
      }),
      this.publishToVisitor(conversation, {type: 'typing', conversationId, agentName: visibleName}),
    ]);
  }


  /**
   * Every message, whatever its source, is written here so the denormalized list fields and every
   * side effect (realtime, notifications, email, events) stay in one place.
   */
  public static async postMessage(conversation: Conversation, input: PostMessageInput): Promise<MessageWithAuthor> {
    const kind = input.kind ?? 'COMMENT';
    const now = new Date();

    const conversationUpdate: Prisma.ConversationUpdateInput = {};
    if (kind === 'COMMENT') {
      conversationUpdate.lastMessageAt = now;
      conversationUpdate.lastMessagePreview = this.preview(input.body);
      conversationUpdate.lastMessageAuthorType = input.authorType;
    }
    if (input.authorType === 'CONTACT') {
      conversationUpdate.lastContactMessageAt = now;
      if (conversation.status === 'CLOSED') {
        conversationUpdate.status = 'OPEN';
        conversationUpdate.closedAt = null;
      }
    }
    if (input.authorType === 'AGENT' && kind === 'COMMENT' && !conversation.firstResponseAt) {
      conversationUpdate.firstResponseAt = now;
    }

    const [message] = await prisma.$transaction([
      prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          authorType: input.authorType,
          authorUserId: input.authorUserId ?? null,
          kind,
          body: input.body,
          source: input.source,
          createdAt: now,
        },
        include: {authorUser: authorSelect},
      }),
      prisma.conversation.update({where: {id: conversation.id}, data: conversationUpdate}),
    ]);

    await Promise.all([
      this.publishToInbox(conversation.projectId, {
        type: 'message',
        conversationId: conversation.id,
        message: this.toInboxMessage(message),
      }),
      kind === 'COMMENT'
        ? this.publishToVisitor(conversation, {
            type: 'message',
            conversationId: conversation.id,
            message: this.toMessengerMessage(message),
          })
        : undefined,
    ]);

    return message;
  }

  private static publishToInbox(projectId: string, event: InboxStreamEvent): Promise<void> {
    return RealtimeHub.publish(Keys.Realtime.project(projectId), event);
  }

  /* Keyed by the visitor id that started the conversation, the same scope the messenger API reads
  by, so a stream never carries another visitor's conversation. */
  private static async publishToVisitor(
    conversation: Pick<Conversation, 'projectId' | 'originVisitorId'>,
    event: MessengerStreamEvent,
  ): Promise<void> {
    if (conversation.originVisitorId) {
      await RealtimeHub.publish(Keys.Realtime.visitor(conversation.projectId, conversation.originVisitorId), event);
    }
  }

  private static async claimTypingSlot(conversationId: string, actor: string): Promise<boolean> {
    try {
      return (await redis.set(Keys.Realtime.typing(conversationId, actor), '1', 'PX', TYPING_THROTTLE_MS, 'NX')) === 'OK';
    } catch {
      return false;
    }
  }


  /**
   * The visitor's contact is whatever their anonymous id currently points at. A first message
   * creates a lead: unsubscribed, because chatting is not consent to marketing.
   */
  private static async resolveVisitorContact(session: MessengerSession): Promise<string> {
    const identityKey = {
      projectId: session.projectId,
      type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID,
      value: session.visitorId,
    };

    const existing = await prisma.contactIdentity.findUnique({
      where: {projectId_type_value: identityKey},
      select: {contactId: true, contact: {select: {deletedAt: true}}},
    });
    if (existing && existing.contact.deletedAt === null) {
      return existing.contactId;
    }

    const lead = await prisma.contact.create({
      data: {projectId: session.projectId, email: null, subscribed: false, data: Prisma.JsonNull},
    });

    try {
      if (existing) {
        await prisma.contactIdentity.update({
          where: {projectId_type_value: identityKey},
          data: {contactId: lead.id, lastSeenAt: new Date()},
        });
      } else {
        await prisma.contactIdentity.create({data: {...identityKey, contactId: lead.id}});
      }
      return lead.id;
    } catch (error) {
      /* Two first messages raced: the other request's lead owns the identity, so this lead is
      discarded and the conversation joins the winner. */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await prisma.contact.delete({where: {id: lead.id}});
        const winner = await prisma.contactIdentity.findUniqueOrThrow({
          where: {projectId_type_value: identityKey},
          select: {contactId: true},
        });
        return winner.contactId;
      }
      throw error;
    }
  }

  /* Scoped by the session's visitor id, not by contact: a lead later merged by email must not
  expose conversations started on someone else's device. */
  private static async requireSessionConversation(
    session: MessengerSession,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await prisma.conversation.findFirst({
      where: {id: conversationId, projectId: session.projectId, originVisitorId: session.visitorId},
    });
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }
    return conversation;
  }

  private static async requireProjectConversation(projectId: string, conversationId: string): Promise<Conversation> {
    const conversation = await prisma.conversation.findFirst({where: {id: conversationId, projectId}});
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }
    return conversation;
  }

  private static async loadThread(conversationId: string, filter: {kind?: MessageKind} = {}) {
    const latest = await prisma.conversationMessage.findMany({
      where: {conversationId, ...filter},
      orderBy: {createdAt: 'desc'},
      take: THREAD_MESSAGE_LIMIT,
      include: {authorUser: authorSelect},
    });
    return latest.reverse();
  }

  private static async readsFor(userId: string, conversationIds: string[]): Promise<Map<string, Date>> {
    if (conversationIds.length === 0) {
      return new Map();
    }
    const reads = await prisma.conversationRead.findMany({
      where: {userId, conversationId: {in: conversationIds}},
      select: {conversationId: true, lastReadAt: true},
    });
    return new Map(reads.map(read => [read.conversationId, read.lastReadAt]));
  }

  private static viewFilter(view: ConversationView, userId: string): Prisma.ConversationWhereInput {
    switch (view) {
      case 'unassigned':
        return {status: 'OPEN', assigneeId: null};
      case 'mine':
        return {status: 'OPEN', assigneeId: userId};
      case 'closed':
        return {status: 'CLOSED'};
      case 'all':
        return {status: 'OPEN'};
    }
  }

  private static encodeCursor(conversation: Pick<Conversation, 'lastMessageAt' | 'id'>): string {
    return Buffer.from(`${conversation.lastMessageAt.toISOString()}|${conversation.id}`).toString('base64url');
  }

  private static decodeCursor(cursor: string): {lastMessageAt: Date; id: string} {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const lastMessageAt = new Date(timestamp ?? '');
    if (!id || Number.isNaN(lastMessageAt.getTime())) {
      throw new HttpException(400, 'Invalid cursor', ErrorCode.BAD_REQUEST);
    }
    return {lastMessageAt, id};
  }

  private static isUnreadByContact(conversation: Conversation): boolean {
    if (conversation.lastMessageAuthorType !== 'AGENT') {
      return false;
    }
    return !conversation.contactLastReadAt || conversation.lastMessageAt > conversation.contactLastReadAt;
  }

  private static preview(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
  }

  private static agentName(user: {name: string | null; email: string}): string {
    return user.name?.trim() || user.email.split('@')[0] || 'Support';
  }

  private static toMessengerMessage(message: MessageWithAuthor): MessengerMessage {
    return {
      id: message.id,
      authorType: message.authorType,
      agent:
        message.authorType === 'AGENT' && message.authorUser
          ? {id: message.authorUser.id, name: message.authorUser.name?.trim() || null}
          : null,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private static toInboxMessage(message: MessageWithAuthor): InboxMessage {
    return {
      id: message.id,
      authorType: message.authorType,
      kind: message.kind,
      author: message.authorUser
        ? {id: message.authorUser.id, name: this.agentName(message.authorUser), email: message.authorUser.email}
        : null,
      body: message.body,
      source: message.source,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private static toInboxSummary(
    conversation: Conversation & {
      contact: {id: string; email: string | null; externalId: string | null; data: Prisma.JsonValue};
    },
    lastReadAt: Date | undefined,
  ): InboxConversationSummary {
    const unread =
      conversation.lastContactMessageAt !== null && (!lastReadAt || conversation.lastContactMessageAt > lastReadAt);

    return {
      id: conversation.id,
      status: conversation.status,
      assigneeId: conversation.assigneeId,
      contact: {
        id: conversation.contact.id,
        email: conversation.contact.email,
        externalId: conversation.contact.externalId,
        data:
          conversation.contact.data && typeof conversation.contact.data === 'object' && !Array.isArray(conversation.contact.data)
            ? (conversation.contact.data as Record<string, unknown>)
            : null,
      },
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      lastMessage:
        conversation.lastMessagePreview !== null && conversation.lastMessageAuthorType !== null
          ? {body: conversation.lastMessagePreview, authorType: conversation.lastMessageAuthorType}
          : null,
      unread,
    };
  }
}
