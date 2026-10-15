import {
  type Conversation,
  type ConversationMessage,
  type ConversationStatus,
  type MessageAuthorType,
  type MessageKind,
  type MessageSource,
  Prisma,
} from '@plunk/db';
import {CONTACT_IDENTITY_TYPES, type ConversationView, normalizeOrigin, resolveBrand} from '@plunk/shared';
import type {
  ChatAttachment,
  InboxAgent,
  InboxConversation,
  InboxCounts,
  InboxStreamEvent,
  InboxConversationSummary,
  InboxMessage,
  InboxPage,
  InboxSystemEvent,
  InboxTag,
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
import {ChatAttachmentService, type IncomingFile, type StoredAttachment} from './ChatAttachmentService.js';
import {ConversationTagService} from './ConversationTagService.js';
import {Keys} from './keys.js';
import {MembershipService} from './MembershipService.js';
import {type MessengerSession, MessengerSessionService} from './MessengerSessionService.js';
import {MessengerContactService} from './MessengerContactService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {ProjectService} from './ProjectService.js';
import {QueueService} from './QueueService.js';
import {RealtimeHub} from './RealtimeHub.js';
import {TurnstileService} from './TurnstileService.js';

const PREVIEW_LENGTH = 140;
const MESSENGER_HISTORY_LIMIT = 20;
/* A thread is loaded whole up to this many messages; older ones are dropped from the view rather
than paginated, which is fine for support threads and keeps the read a single indexed query. */
const THREAD_MESSAGE_LIMIT = 200;

const API_ORIGIN = normalizeOrigin(API_URI);
/* Clients send typing at most every few seconds; this caps what a misbehaving one can publish. */
const TYPING_THROTTLE_MS = 2000;

/* Counting a view stops here, so a project with years of closed conversations never pays for an
exact count on every inbox refresh. */
export const INBOX_COUNT_CAP = 1000;
/* Each sweep run wakes at most this many conversations; the rest wait a minute for the next run. */
const SNOOZE_SWEEP_BATCH = 200;
const SNOOZE_SWEEP_MAX_BATCHES = 25;
/* A transition guarded on stale state re-reads and retries this often before giving up. */
const TRANSITION_ATTEMPTS = 3;

const authorSelect = {select: {id: true, name: true, email: true}} as const;

const messageInclude = {
  authorUser: authorSelect,
  attachments: {select: {id: true, filename: true, contentType: true, size: true}, orderBy: {createdAt: 'asc'}},
} as const;

type ConversationState = Pick<Conversation, 'status' | 'snoozedUntil' | 'assigneeId'>;

export type StatusChange =
  | {status: 'OPEN'}
  | {status: 'CLOSED'}
  | {status: 'SNOOZED'; snoozedUntil: Date | null};

type MessageWithAuthor = ConversationMessage & {
  authorUser: {id: string; name: string | null; email: string} | null;
  attachments: ChatAttachment[];
};

interface PostMessageInput {
  authorType: MessageAuthorType;
  authorUserId?: string | null;
  kind?: MessageKind;
  body: string;
  source: MessageSource;
  mentionedUserIds?: string[];
  attachment?: StoredAttachment;
}

type MentionNames = Map<string, string>;

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
      visitor: {hasEmail: await MessengerContactService.hasEmail(project.id, input.visitorId)},
      turnstileSiteKey: TurnstileService.siteKey(),
    };
  }

  public static async startConversation(session: MessengerSession, body: string): Promise<MessengerStartResponse> {
    const contactId = await MessengerContactService.resolveVisitorContact(session);

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
    const messages = await this.loadThread(conversation.id, {kind: 'COMMENT', authorType: {not: 'SYSTEM'}});

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

  public static async sendAttachmentFromContact(
    session: MessengerSession,
    conversationId: string,
    file: IncomingFile,
    body: string,
  ): Promise<MessengerMessage> {
    const conversation = await this.requireSessionConversation(session, conversationId);
    const message = await this.postWithAttachment(conversation, file, {authorType: 'CONTACT', body, source: 'WIDGET'});
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
    options: {view: ConversationView; tag?: string; cursor?: string; limit: number},
  ): Promise<InboxPage> {
    const cursor = options.cursor ? this.decodeCursor(options.cursor) : null;
    const after: Prisma.ConversationWhereInput = cursor
      ? {
          OR: [
            {lastMessageAt: {lt: cursor.lastMessageAt}},
            {lastMessageAt: cursor.lastMessageAt, id: {lt: cursor.id}},
          ],
        }
      : {};
    /* Probed per row through the assignment primary key, or driven from the tagId index when the
    tag is rare; the planner picks, both are index-backed. */
    const tagged: Prisma.ConversationWhereInput = options.tag ? {tags: {some: {tagId: options.tag}}} : {};

    /* A view spanning several statuses is read as one index-ordered range per status and merged,
    because a single status IN (...) query cannot be read in lastMessageAt order from the index. */
    const ranges = await Promise.all(
      this.viewRanges(options.view, userId).map(range =>
        prisma.conversation.findMany({
          where: {projectId, ...range, ...after, ...tagged},
          orderBy: [{lastMessageAt: 'desc'}, {id: 'desc'}],
          take: options.limit + 1,
          include: {contact: {select: {id: true, email: true, externalId: true, data: true}}},
        }),
      ),
    );
    const rows = ranges
      .flat()
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, options.limit + 1);

    const page = rows.slice(0, options.limit);
    const ids = page.map(row => row.id);
    const [reads, tags] = await Promise.all([this.readsFor(userId, ids), ConversationTagService.forConversations(ids)]);

    const last = page[page.length - 1];
    return {
      conversations: page.map(row => this.toInboxSummary(row, reads.get(row.id), tags.get(row.id))),
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

    const [messages, reads, tags] = await Promise.all([
      this.loadThread(conversation.id),
      this.readsFor(userId, [conversation.id]),
      ConversationTagService.forConversations([conversation.id]),
    ]);
    const names = await this.mentionNames(messages);

    return {
      ...this.toInboxSummary(conversation, reads.get(conversation.id), tags.get(conversation.id)),
      channel: conversation.channel,
      contactLastReadAt: conversation.contactLastReadAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      messages: messages.map(message => this.toInboxMessage(message, names)),
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

  public static async replyWithAttachment(
    projectId: string,
    userId: string,
    conversationId: string,
    file: IncomingFile,
    body: string,
  ): Promise<InboxMessage> {
    const conversation = await this.requireProjectConversation(projectId, conversationId);
    const message = await this.postWithAttachment(conversation, file, {
      authorType: 'AGENT',
      authorUserId: userId,
      body,
      source: 'DASHBOARD',
    });
    await this.markReadByAgent(projectId, userId, conversationId);
    return this.toInboxMessage(message);
  }

  /**
   * An internal note: never shown or sent to the visitor, and never a response, so it changes
   * neither the conversation's state nor its place in the list. Only support agents of the
   * project can be mentioned.
   */
  public static async addNote(
    projectId: string,
    userId: string,
    conversationId: string,
    input: {body: string; mentionedUserIds: string[]},
  ): Promise<InboxMessage> {
    const conversation = await this.requireProjectConversation(projectId, conversationId);
    const mentionedUserIds = [...new Set(input.mentionedUserIds)];
    if (mentionedUserIds.length > 0) {
      const agentIds = new Set((await this.agents(projectId)).map(agent => agent.id));
      if (mentionedUserIds.some(id => !agentIds.has(id))) {
        throw new HttpException(400, 'Only support agents of this project can be mentioned', ErrorCode.BAD_REQUEST);
      }
    }

    const message = await this.postMessage(conversation, {
      authorType: 'AGENT',
      authorUserId: userId,
      kind: 'NOTE',
      body: input.body,
      source: 'DASHBOARD',
      mentionedUserIds,
    });
    await this.markReadByAgent(projectId, userId, conversationId);
    if (mentionedUserIds.some(id => id !== userId)) {
      await QueueService.queueChatNotification({type: 'mention', messageId: message.id});
    }
    return this.toInboxMessage(message, await this.mentionNames([message]));
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


  public static async setStatus(
    projectId: string,
    userId: string,
    conversationId: string,
    change: StatusChange,
  ): Promise<InboxConversation> {
    if (change.status === 'SNOOZED' && change.snoozedUntil && change.snoozedUntil.getTime() <= Date.now()) {
      throw new HttpException(400, 'Snooze until a time in the future', ErrorCode.BAD_REQUEST);
    }

    await this.transition(projectId, userId, conversationId, current => {
      switch (change.status) {
        case 'CLOSED':
          return current.status === 'CLOSED'
            ? null
            : {data: {status: 'CLOSED', closedAt: new Date(), snoozedUntil: null}, event: {action: 'closed'}};
        case 'OPEN':
          return current.status === 'OPEN'
            ? null
            : {
                data: {status: 'OPEN', closedAt: null, snoozedUntil: null},
                event: {action: 'reopened', trigger: 'agent'},
              };
        case 'SNOOZED':
          return current.status === 'SNOOZED' &&
            (current.snoozedUntil?.getTime() ?? null) === (change.snoozedUntil?.getTime() ?? null)
            ? null
            : {
                data: {status: 'SNOOZED', snoozedUntil: change.snoozedUntil, closedAt: null},
                event: {action: 'snoozed', until: change.snoozedUntil?.toISOString() ?? null},
              };
      }
    });
    return this.get(projectId, userId, conversationId);
  }

  public static async assign(
    projectId: string,
    userId: string,
    conversationId: string,
    assigneeId: string | null,
  ): Promise<InboxConversation> {
    let assignee: InboxAgent | null = null;
    if (assigneeId) {
      assignee = (await this.agents(projectId)).find(agent => agent.id === assigneeId) ?? null;
      if (!assignee) {
        throw new HttpException(400, 'Only support agents of this project can be assigned', ErrorCode.BAD_REQUEST);
      }
    }

    await this.transition(projectId, userId, conversationId, current => {
      if (current.assigneeId === assigneeId) {
        return null;
      }
      return {
        data: {assigneeId},
        event: assignee
          ? {action: 'assigned', assignee: {id: assignee.id, name: assignee.name}}
          : {action: 'unassigned'},
      };
    });
    return this.get(projectId, userId, conversationId);
  }

  /** Members who can be assigned: the owner and every member flagged as a support agent. */
  public static async agents(projectId: string): Promise<InboxAgent[]> {
    const members = await MembershipService.getMembers(projectId);
    return members
      .filter(member => MembershipService.isSupportAgent(member))
      .map(member => ({id: member.userId, name: this.agentName(member), email: member.email}));
  }

  public static async counts(projectId: string, userId: string): Promise<InboxCounts> {
    const count = (where: Prisma.ConversationWhereInput) =>
      prisma.conversation.count({where: {projectId, ...where}, take: INBOX_COUNT_CAP});
    const [unassigned, mine, open, snoozed, closed] = await Promise.all([
      ...this.viewRanges('unassigned', userId).map(count),
      ...this.viewRanges('mine', userId).map(count),
      ...this.viewRanges('all', userId).map(count),
      ...this.viewRanges('closed', userId).map(count),
    ]);
    return {
      unassigned: unassigned ?? 0,
      mine: mine ?? 0,
      all: Math.min((open ?? 0) + (snoozed ?? 0), INBOX_COUNT_CAP),
      closed: closed ?? 0,
      cap: INBOX_COUNT_CAP,
    };
  }

  /**
   * Reopens snoozed conversations whose date has passed. Run by the snooze sweep every minute;
   * returns how many it woke.
   */
  public static async wakeSnoozed(now: Date = new Date()): Promise<number> {
    let woken = 0;
    for (let batch = 0; batch < SNOOZE_SWEEP_MAX_BATCHES; batch++) {
      const due = await prisma.conversation.findMany({
        where: {status: 'SNOOZED', snoozedUntil: {lte: now}},
        orderBy: {snoozedUntil: 'asc'},
        take: SNOOZE_SWEEP_BATCH,
      });
      for (const conversation of due) {
        const line = await this.applyTransition(
          conversation,
          {data: {status: 'OPEN', snoozedUntil: null}, event: {action: 'reopened', trigger: 'snooze_expired'}},
          null,
        );
        if (line) {
          woken++;
          await this.publishTransition(conversation, line, 'OPEN');
        }
      }
      if (due.length < SNOOZE_SWEEP_BATCH) {
        break;
      }
    }
    return woken;
  }

  /* Applies the change only if the conversation still has the state it was computed from, so two
  agents acting at once, or an agent racing the sweep, never record the same change twice. */
  private static async transition(
    projectId: string,
    userId: string,
    conversationId: string,
    plan: (current: Conversation) => {data: Prisma.ConversationUncheckedUpdateManyInput; event: InboxSystemEvent} | null,
  ): Promise<void> {
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt++) {
      const current = await this.requireProjectConversation(projectId, conversationId);
      const change = plan(current);
      if (!change) {
        return;
      }
      const line = await this.applyTransition(current, change, userId);
      if (line) {
        await this.publishTransition(current, line, (change.data.status as ConversationStatus | undefined) ?? null);
        return;
      }
    }
    throw new HttpException(409, 'This conversation was changed at the same time; try again', ErrorCode.CONFLICT);
  }

  private static applyTransition(
    current: Conversation,
    change: {data: Prisma.ConversationUncheckedUpdateManyInput; event: InboxSystemEvent},
    actorUserId: string | null,
  ): Promise<MessageWithAuthor | null> {
    const guard: ConversationState = {
      status: current.status,
      snoozedUntil: current.snoozedUntil,
      assigneeId: current.assigneeId,
    };
    return prisma.$transaction(async tx => {
      const {count} = await tx.conversation.updateMany({where: {id: current.id, ...guard}, data: change.data});
      return count === 1 ? this.createSystemLine(tx, current, change.event, actorUserId, new Date()) : null;
    });
  }

  private static createSystemLine(
    tx: Prisma.TransactionClient,
    conversation: Pick<Conversation, 'id' | 'projectId'>,
    event: InboxSystemEvent,
    actorUserId: string | null,
    createdAt: Date,
  ): Promise<MessageWithAuthor> {
    return tx.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        authorType: 'SYSTEM',
        authorUserId: actorUserId,
        kind: 'NOTE',
        body: this.describeEvent(event),
        source: 'SYSTEM',
        meta: event as unknown as Prisma.InputJsonObject,
        createdAt,
      },
      include: messageInclude,
    });
  }

  private static async publishTransition(
    conversation: Pick<Conversation, 'id' | 'projectId' | 'originVisitorId'>,
    line: MessageWithAuthor,
    status: ConversationStatus | null,
  ): Promise<void> {
    await Promise.all([
      this.publishToInbox(conversation.projectId, {
        type: 'message',
        conversationId: conversation.id,
        message: this.toInboxMessage(line),
      }),
      this.publishToInbox(conversation.projectId, {type: 'conversation', conversationId: conversation.id}),
      status
        ? this.publishToVisitor(conversation, {type: 'conversation', conversationId: conversation.id, status})
        : undefined,
    ]);
  }

  private static describeEvent(event: InboxSystemEvent): string {
    switch (event.action) {
      case 'closed':
        return 'Closed the conversation';
      case 'reopened':
        return event.trigger === 'contact'
          ? 'Reopened by a new message from the visitor'
          : event.trigger === 'snooze_expired'
            ? 'Reopened when the snooze ended'
            : 'Reopened the conversation';
      case 'snoozed':
        return event.until ? `Snoozed until ${event.until}` : 'Snoozed until the visitor replies';
      case 'assigned':
        return `Assigned to ${event.assignee.name}`;
      case 'unassigned':
        return 'Unassigned the conversation';
    }
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
      conversationUpdate.lastMessagePreview = this.preview(input.body || (input.attachment ? `📎 ${input.attachment.filename}` : ''));
      conversationUpdate.lastMessageAuthorType = input.authorType;
    }
    if (input.authorType === 'CONTACT') {
      conversationUpdate.lastContactMessageAt = now;
    }
    if (input.authorType === 'AGENT' && kind === 'COMMENT' && !conversation.firstResponseAt) {
      conversationUpdate.firstResponseAt = now;
    }

    const {message, reopened} = await prisma.$transaction(async tx => {
      /* Guarded on the stored status, not the possibly stale one passed in, so a reply racing an
      agent's close still reopens exactly once. */
      let reopened: MessageWithAuthor | null = null;
      if (input.authorType === 'CONTACT') {
        const {count} = await tx.conversation.updateMany({
          where: {id: conversation.id, status: {in: ['CLOSED', 'SNOOZED']}},
          data: {status: 'OPEN', closedAt: null, snoozedUntil: null},
        });
        if (count === 1) {
          reopened = await this.createSystemLine(
            tx,
            conversation,
            {action: 'reopened', trigger: 'contact'},
            null,
            new Date(now.getTime() - 1),
          );
        }
      }
      const message = await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          authorType: input.authorType,
          authorUserId: input.authorUserId ?? null,
          kind,
          body: input.body,
          source: input.source,
          mentionedUserIds: input.mentionedUserIds ?? [],
          createdAt: now,
          attachments: input.attachment
            ? {create: {...input.attachment, conversationId: conversation.id, projectId: conversation.projectId}}
            : undefined,
        },
        include: messageInclude,
      });
      if (Object.keys(conversationUpdate).length > 0) {
        await tx.conversation.update({where: {id: conversation.id}, data: conversationUpdate});
      }
      return {message, reopened};
    });

    if (reopened) {
      await this.publishTransition(conversation, reopened, 'OPEN');
    }

    await Promise.all([
      this.publishToInbox(conversation.projectId, {
        type: 'message',
        conversationId: conversation.id,
        message: this.toInboxMessage(message, await this.mentionNames([message])),
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

  private static async postWithAttachment(
    conversation: Conversation,
    file: IncomingFile,
    input: Omit<PostMessageInput, 'attachment'>,
  ): Promise<MessageWithAuthor> {
    const attachment = await ChatAttachmentService.store(conversation.projectId, conversation.id, file);
    try {
      return await this.postMessage(conversation, {...input, attachment});
    } catch (error) {
      await ChatAttachmentService.discard(attachment.key);
      throw error;
    }
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

  private static async loadThread(conversationId: string, filter: Prisma.ConversationMessageWhereInput = {}) {
    const latest = await prisma.conversationMessage.findMany({
      where: {conversationId, ...filter},
      orderBy: {createdAt: 'desc'},
      take: THREAD_MESSAGE_LIMIT,
      include: messageInclude,
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

  /* Each range matches a prefix of (projectId, status, lastMessageAt) or
  (projectId, assigneeId, status, lastMessageAt), so every view is an index range scan. */
  private static viewRanges(view: ConversationView, userId: string): Prisma.ConversationWhereInput[] {
    switch (view) {
      case 'unassigned':
        return [{assigneeId: null, status: 'OPEN'}];
      case 'mine':
        return [{assigneeId: userId, status: 'OPEN'}];
      case 'closed':
        return [{status: 'CLOSED'}];
      case 'all':
        return [{status: 'OPEN'}, {status: 'SNOOZED'}];
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

  public static preview(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
  }

  public static agentName(user: {name: string | null; email: string}): string {
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
      attachments: message.attachments,
      createdAt: message.createdAt.toISOString(),
    };
  }

  public static async mentionNames(messages: Pick<ConversationMessage, 'mentionedUserIds'>[]): Promise<MentionNames> {
    const ids = [...new Set(messages.flatMap(message => message.mentionedUserIds))];
    if (ids.length === 0) {
      return new Map();
    }
    const users = await prisma.user.findMany({where: {id: {in: ids}}, select: {id: true, name: true, email: true}});
    return new Map(users.map(user => [user.id, this.agentName(user)]));
  }

  private static toInboxMessage(message: MessageWithAuthor, names: MentionNames = new Map()): InboxMessage {
    return {
      id: message.id,
      authorType: message.authorType,
      kind: message.kind,
      author: message.authorUser
        ? {id: message.authorUser.id, name: this.agentName(message.authorUser), email: message.authorUser.email}
        : null,
      body: message.body,
      source: message.source,
      event: message.authorType === 'SYSTEM' && message.meta ? (message.meta as unknown as InboxSystemEvent) : null,
      mentions: message.mentionedUserIds.flatMap(id => {
        const name = names.get(id);
        return name ? [{id, name}] : [];
      }),
      attachments: message.attachments,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private static toInboxSummary(
    conversation: Conversation & {
      contact: {id: string; email: string | null; externalId: string | null; data: Prisma.JsonValue};
    },
    lastReadAt: Date | undefined,
    tags: InboxTag[] = [],
  ): InboxConversationSummary {
    const unread =
      conversation.lastContactMessageAt !== null && (!lastReadAt || conversation.lastContactMessageAt > lastReadAt);

    return {
      id: conversation.id,
      status: conversation.status,
      assigneeId: conversation.assigneeId,
      snoozedUntil: conversation.snoozedUntil?.toISOString() ?? null,
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
      tags,
    };
  }
}
