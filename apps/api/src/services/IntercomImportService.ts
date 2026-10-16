import {randomUUID} from 'node:crypto';

import {type ChatImport, type MessageAuthorType, type MessageKind, Prisma} from '@plunk/db';
import {MESSAGE_BODY_MAX_LENGTH} from '@plunk/shared';
import type {ChatImportRun} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {ConflictError, ErrorCode, HttpException} from '../exceptions/index.js';
import {ContactService} from './ContactService.js';
import {ConversationService} from './ConversationService.js';
import {Keys} from './keys.js';
import {MembershipService} from './MembershipService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';

const INTERCOM_API = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.11';
const SOURCE = 'intercom';
const PAGE_SIZE = 150;
const CONCURRENCY = 5;
const PROGRESS_EVERY = 25;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 6;
const MAX_RETRY_WAIT_MS = 60_000;
/* Refreshed per page, so a run cut off by a restart frees the project within this time. */
const LOCK_TTL_SECONDS = 10 * 60;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const CONTACT_AUTHORS = new Set(['user', 'lead', 'contact']);

const SKIP = {
  alreadyImported: 'already imported',
  pastRetention: 'past retention',
  noContact: 'no contact',
  anonymousContact: 'contact without email or user id',
  erasedContact: 'contact was erased',
  conflictingContact: 'email belongs to another user id',
  deletedContact: 'contact deleted in Intercom',
  empty: 'no messages',
} as const;

interface IntercomAuthor {
  type?: string;
  id?: string;
  email?: string | null;
}

interface IntercomAttachment {
  name?: string;
}

interface IntercomPart {
  part_type?: string;
  body?: string | null;
  created_at?: number;
  author?: IntercomAuthor;
  attachments?: IntercomAttachment[];
  redacted?: boolean;
}

interface IntercomListedConversation {
  id: string;
  updated_at?: number;
}

interface IntercomConversation {
  id: string;
  created_at: number;
  updated_at?: number;
  source?: IntercomPart & {redacted?: boolean};
  contacts?: {contacts?: {id: string}[]};
  conversation_parts?: {conversation_parts?: IntercomPart[]};
}

interface IntercomContact {
  id: string;
  external_id?: string | null;
  email?: string | null;
  name?: string | null;
}

interface ListPage<T> {
  total_count?: number;
  pages?: {next?: {starting_after?: string | null} | null};
  conversations?: T[];
}

type ContactResolution = {contactId: string} | {skip: string};

interface ImportedMessage {
  authorType: MessageAuthorType;
  authorUserId: string | null;
  kind: MessageKind;
  body: string;
  createdAt: Date;
}

interface RunContext {
  runId: string;
  projectId: string;
  token: string;
  retentionCutoff: Date;
  agents: Map<string, string | null>;
  memberByEmail: Map<string, string>;
  contacts: Map<string, Promise<ContactResolution>>;
  counts: {imported: number; skipped: number; failed: number; skipReasons: Record<string, number>};
}

export class IntercomError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A one-off, re-runnable copy of an Intercom workspace's conversations into the Inbox. It runs in
 * the API process rather than on the job queue because queued job data is stored in Redis, and
 * the access token must never be stored anywhere: it lives only in this run's arguments.
 *
 * Imported conversations are closed and read-only. Nothing is emailed, pushed or evented for
 * them, and existing contacts are never changed, subscription state included.
 */
export class IntercomImportService {
  /**
   * Validates the token, sizes the workspace and starts the run. `finished` settles when the run
   * does; the API answers without waiting for it.
   */
  public static async start(
    projectId: string,
    userId: string,
    token: string,
  ): Promise<{run: ChatImportRun; finished: Promise<void>}> {
    await this.request(token, '/me').catch(error => {
      throw this.startError(error);
    });

    const lockKey = Keys.Messenger.importLock(projectId);
    const runId = randomUUID();
    if ((await redis.set(lockKey, runId, 'EX', LOCK_TTL_SECONDS, 'NX')) !== 'OK') {
      throw new ConflictError('An import is already running for this project');
    }

    try {
      const [conversations, contacts] = await Promise.all([
        this.request<ListPage<unknown>>(token, '/conversations?per_page=1'),
        this.request<ListPage<unknown>>(token, '/contacts?per_page=1'),
      ]);
      await prisma.chatImport.updateMany({
        where: {projectId, status: 'RUNNING'},
        data: {status: 'FAILED', error: 'Stopped before it finished', finishedAt: new Date()},
      });
      const run = await prisma.chatImport.create({
        data: {
          id: runId,
          projectId,
          source: SOURCE,
          startedByUserId: userId,
          totalConversations: conversations.total_count ?? null,
          totalContacts: contacts.total_count ?? null,
        },
      });
      const finished = this.run(run, token).finally(() => this.releaseLock(projectId, runId).catch(() => undefined));
      return {run: this.toView(run, true), finished};
    } catch (error) {
      await this.releaseLock(projectId, runId);
      throw this.startError(error);
    }
  }

  public static async latest(projectId: string): Promise<ChatImportRun | null> {
    const run = await prisma.chatImport.findFirst({where: {projectId}, orderBy: {startedAt: 'desc'}});
    if (!run) {
      return null;
    }
    const locked = run.status === 'RUNNING' ? (await redis.get(Keys.Messenger.importLock(projectId))) === run.id : false;
    return this.toView(run, locked);
  }

  private static async run(run: ChatImport, token: string): Promise<void> {
    try {
      const context = await this.context(run, token);
      let startingAfter: string | null | undefined;
      do {
        const query = new URLSearchParams({per_page: String(PAGE_SIZE)});
        if (startingAfter) query.set('starting_after', startingAfter);
        const page = await this.request<ListPage<IntercomListedConversation>>(token, `/conversations?${query}`);
        await this.importPage(context, page.conversations ?? []);
        await this.saveProgress(context);
        await redis.expire(Keys.Messenger.importLock(run.projectId), LOCK_TTL_SECONDS);
        startingAfter = page.pages?.next?.starting_after;
      } while (startingAfter);

      await prisma.chatImport.update({
        where: {id: run.id},
        data: {...this.progress(context), status: 'COMPLETED', finishedAt: new Date()},
      });
    } catch (error) {
      signale.error(`[INTERCOM-IMPORT] Run ${run.id} failed:`, error instanceof Error ? error.message : error);
      await prisma.chatImport
        .update({
          where: {id: run.id},
          data: {status: 'FAILED', error: this.describe(error), finishedAt: new Date()},
        })
        .catch(() => undefined);
    }
  }

  private static async context(run: ChatImport, token: string): Promise<RunContext> {
    const [settings, members, admins] = await Promise.all([
      MessengerSettingsService.get(run.projectId),
      MembershipService.getMembers(run.projectId),
      this.request<{admins?: {id: string; email?: string | null}[]}>(token, '/admins'),
    ]);
    const memberByEmail = new Map(members.map(member => [member.email.toLowerCase(), member.userId]));
    return {
      runId: run.id,
      projectId: run.projectId,
      token,
      retentionCutoff: new Date(Date.now() - settings.retentionMonths * MONTH_MS),
      agents: new Map((admins.admins ?? []).map(admin => [admin.id, memberByEmail.get(admin.email?.toLowerCase() ?? '') ?? null])),
      memberByEmail,
      contacts: new Map(),
      counts: {imported: 0, skipped: 0, failed: 0, skipReasons: {}},
    };
  }

  private static async importPage(context: RunContext, listed: IntercomListedConversation[]): Promise<void> {
    const known = await prisma.conversation.findMany({
      where: {projectId: context.projectId, importedFrom: {in: listed.map(item => this.importKey(item.id))}},
      select: {importedFrom: true},
    });
    const imported = new Set(known.map(row => row.importedFrom));

    const pending: IntercomListedConversation[] = [];
    for (const item of listed) {
      if (imported.has(this.importKey(item.id))) {
        this.skip(context, SKIP.alreadyImported);
      } else if (item.updated_at && item.updated_at * 1000 < context.retentionCutoff.getTime()) {
        this.skip(context, SKIP.pastRetention);
      } else {
        pending.push(item);
      }
    }

    let done = 0;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CONCURRENCY).map(item => this.importOne(context, item.id)));
      done += CONCURRENCY;
      if (done % PROGRESS_EVERY === 0) {
        await this.saveProgress(context);
      }
    }
  }

  private static async importOne(context: RunContext, intercomId: string): Promise<void> {
    try {
      const detail = await this.request<IntercomConversation>(
        context.token,
        `/conversations/${encodeURIComponent(intercomId)}?display_as=plaintext`,
      );
      const outcome = await this.write(context, detail);
      if (outcome === 'imported') {
        context.counts.imported++;
      } else {
        this.skip(context, outcome.skip);
      }
    } catch (error) {
      if (error instanceof IntercomError && error.status === 401) {
        throw error;
      }
      context.counts.failed++;
      signale.warn(`[INTERCOM-IMPORT] Conversation ${intercomId} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private static async write(context: RunContext, detail: IntercomConversation): Promise<'imported' | {skip: string}> {
    const lastActivity = (detail.updated_at ?? detail.created_at) * 1000;
    if (lastActivity < context.retentionCutoff.getTime()) {
      return {skip: SKIP.pastRetention};
    }
    const intercomContactId = detail.contacts?.contacts?.[0]?.id;
    if (!intercomContactId) {
      return {skip: SKIP.noContact};
    }
    const contact = await this.resolveContact(context, intercomContactId);
    if ('skip' in contact) {
      return contact;
    }

    const messages = this.messages(context, detail);
    if (messages.length === 0) {
      return {skip: SKIP.empty};
    }

    const comments = messages.filter(message => message.kind === 'COMMENT');
    const lastComment = comments[comments.length - 1];
    const last = messages[messages.length - 1]!;
    const lastContactComment = [...comments].reverse().find(message => message.authorType === 'CONTACT');
    const firstAgentComment = comments.find(message => message.authorType === 'AGENT');

    try {
      await prisma.conversation.create({
        data: {
          projectId: context.projectId,
          contactId: contact.contactId,
          status: 'CLOSED',
          channel: 'IMPORT',
          importedFrom: this.importKey(detail.id),
          originVisitorId: null,
          lastMessageAt: lastComment?.createdAt ?? last.createdAt,
          lastMessagePreview: lastComment ? ConversationService.preview(lastComment.body) : null,
          lastMessageAuthorType: lastComment?.authorType ?? null,
          lastContactMessageAt: lastContactComment?.createdAt ?? null,
          firstResponseAt: firstAgentComment?.createdAt ?? null,
          contactLastReadAt: last.createdAt,
          closedAt: last.createdAt,
          createdAt: messages[0]!.createdAt,
          messages: {
            createMany: {
              data: messages.map(message => ({
                projectId: context.projectId,
                authorType: message.authorType,
                authorUserId: message.authorUserId,
                kind: message.kind,
                body: message.body,
                source: 'IMPORT' as const,
                createdAt: message.createdAt,
              })),
            },
          },
        },
      });
      return 'imported';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return {skip: SKIP.alreadyImported};
      }
      throw error;
    }
  }

  /* Resolved once per Intercom contact per run. An existing contact is used exactly as it is, so
  an import never touches anyone's attributes or subscription; a new one is created unsubscribed,
  like a messenger lead, because a support chat is not consent to marketing. */
  private static resolveContact(context: RunContext, intercomContactId: string): Promise<ContactResolution> {
    let resolution = context.contacts.get(intercomContactId);
    if (!resolution) {
      resolution = this.findOrCreateContact(context, intercomContactId);
      context.contacts.set(intercomContactId, resolution);
    }
    return resolution;
  }

  private static async findOrCreateContact(context: RunContext, intercomContactId: string): Promise<ContactResolution> {
    let source: IntercomContact;
    try {
      source = await this.request<IntercomContact>(context.token, `/contacts/${encodeURIComponent(intercomContactId)}`);
    } catch (error) {
      if (error instanceof IntercomError && error.status === 404) {
        return {skip: SKIP.deletedContact};
      }
      context.contacts.delete(intercomContactId);
      throw error;
    }

    const projectId = context.projectId;
    const externalId = source.external_id?.trim() || null;
    const email = source.email?.trim() ? ContactService.normalizeEmail(source.email) : null;
    const name = source.name?.trim();

    if (externalId) {
      const existing = await prisma.contact.findFirst({where: {projectId, externalId}, select: {id: true, deletedAt: true}});
      if (existing) {
        return existing.deletedAt ? {skip: SKIP.erasedContact} : {contactId: existing.id};
      }
    }
    if (email) {
      const existing = await prisma.contact.findFirst({where: {projectId, email}, select: {id: true, externalId: true}});
      if (existing) {
        return existing.externalId && externalId && existing.externalId !== externalId
          ? {skip: SKIP.conflictingContact}
          : {contactId: existing.id};
      }
    }
    if (!externalId && !email) {
      return {skip: SKIP.anonymousContact};
    }

    const data = name ? {name} : undefined;
    try {
      const created = externalId
        ? await ContactService.identify(projectId, externalId, data, undefined, email ?? undefined, undefined, false)
        : await ContactService.upsert(projectId, email!, data, undefined, false);
      return {contactId: created.id};
    } catch (error) {
      if (error instanceof HttpException && error.code === 409) {
        return {skip: SKIP.conflictingContact};
      }
      context.contacts.delete(intercomContactId);
      throw error;
    }
  }

  /* The opening message and every part with something in it, oldest first. Parts without text
  (assignments, state changes) are dropped; attachments are not copied, only named. */
  private static messages(context: RunContext, detail: IntercomConversation): ImportedMessage[] {
    const parts: IntercomPart[] = [
      ...(detail.source ? [{...detail.source, created_at: detail.created_at, part_type: 'comment'}] : []),
      ...(detail.conversation_parts?.conversation_parts ?? []),
    ];

    const messages: ImportedMessage[] = [];
    let previous = 0;
    for (const part of parts) {
      const body = this.body(part);
      if (!body) continue;
      const fromContact = CONTACT_AUTHORS.has(part.author?.type ?? '');
      /* Intercom times are in seconds and the thread is ordered by createdAt. */
      const at = Math.max((part.created_at ?? detail.created_at) * 1000, previous + 1);
      previous = at;
      messages.push({
        authorType: fromContact ? 'CONTACT' : 'AGENT',
        authorUserId: fromContact ? null : this.agentFor(context, part.author),
        kind: !fromContact && part.part_type === 'note' ? 'NOTE' : 'COMMENT',
        body,
        createdAt: new Date(at),
      });
    }
    return messages;
  }

  private static agentFor(context: RunContext, author: IntercomAuthor | undefined): string | null {
    if (!author || author.type !== 'admin') {
      return null;
    }
    const byId = author.id ? context.agents.get(author.id) : undefined;
    return byId ?? context.memberByEmail.get(author.email?.toLowerCase() ?? '') ?? null;
  }

  private static body(part: IntercomPart): string {
    if (part.redacted) {
      return '(Removed in Intercom)';
    }
    const text = this.plainText(part.body ?? '');
    const files = (part.attachments ?? []).map(file => file.name?.trim()).filter((name): name is string => !!name);
    const note = files.length > 0 ? `[Attachment not imported: ${files.join(', ')}]` : '';
    const body = [text, note].filter(Boolean).join('\n\n');
    return body.length > MESSAGE_BODY_MAX_LENGTH ? `${body.slice(0, MESSAGE_BODY_MAX_LENGTH - 1)}…` : body;
  }

  /* Bodies are asked for as plain text; this is the fallback for any HTML that comes back anyway.
  The Inbox escapes bodies when it renders them, so this is about legibility, not safety. */
  private static plainText(raw: string): string {
    return raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private static async request<T>(token: string, path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(`${INTERCOM_API}${path}`, {
          headers: {Authorization: `Bearer ${token}`, Accept: 'application/json', 'Intercom-Version': INTERCOM_VERSION},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new IntercomError(0, `Intercom could not be reached: ${error instanceof Error ? error.message : 'network error'}`);
        }
      }
      if (response?.ok) {
        return (await response.json()) as T;
      }
      const retryable = !response || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new IntercomError(response!.status, await this.errorMessage(response!));
      }
      await new Promise(resolve => setTimeout(resolve, this.retryDelay(response, attempt)));
    }
  }

  private static retryDelay(response: Response | null, attempt: number): number {
    const reset = Number(response?.headers.get('X-RateLimit-Reset'));
    if (response?.status === 429 && Number.isFinite(reset) && reset > 0) {
      return Math.min(Math.max(reset * 1000 - Date.now(), 0) + 100, MAX_RETRY_WAIT_MS);
    }
    return Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
  }

  private static async errorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {errors?: {message?: string}[]};
      return body.errors?.[0]?.message ?? `Intercom answered ${response.status}`;
    } catch {
      return `Intercom answered ${response.status}`;
    }
  }

  private static startError(error: unknown): unknown {
    if (!(error instanceof IntercomError)) {
      return error;
    }
    if (error.status === 401 || error.status === 403) {
      return new HttpException(
        422,
        'Intercom did not accept this access token. Check it was copied whole and can read conversations and contacts.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    return new HttpException(502, `Intercom could not be read: ${error.message}`, ErrorCode.EXTERNAL_SERVICE_ERROR);
  }

  private static describe(error: unknown): string {
    if (error instanceof IntercomError) {
      return error.status === 401
        ? 'Intercom stopped accepting the access token'
        : `Intercom could not be read: ${error.message}`;
    }
    return 'The import stopped on an unexpected error';
  }

  private static skip(context: RunContext, reason: string): void {
    context.counts.skipped++;
    context.counts.skipReasons[reason] = (context.counts.skipReasons[reason] ?? 0) + 1;
  }

  private static progress(context: RunContext) {
    return {
      imported: context.counts.imported,
      skipped: context.counts.skipped,
      failed: context.counts.failed,
      skipReasons: context.counts.skipReasons,
      heartbeatAt: new Date(),
    };
  }

  private static async saveProgress(context: RunContext): Promise<void> {
    await prisma.chatImport.update({where: {id: context.runId}, data: this.progress(context)});
  }

  private static async releaseLock(projectId: string, runId: string): Promise<void> {
    const key = Keys.Messenger.importLock(projectId);
    if ((await redis.get(key)) === runId) {
      await redis.del(key);
    }
  }

  private static importKey(intercomId: string): string {
    return `${SOURCE}:${intercomId}`;
  }

  /* A RUNNING row whose lock is gone was cut off by a restart: it is reported as interrupted. */
  private static toView(run: ChatImport, locked: boolean): ChatImportRun {
    return {
      id: run.id,
      source: run.source,
      status: run.status === 'RUNNING' && !locked ? 'INTERRUPTED' : run.status,
      totalContacts: run.totalContacts,
      totalConversations: run.totalConversations,
      imported: run.imported,
      skipped: run.skipped,
      failed: run.failed,
      skipReasons: (run.skipReasons ?? {}) as Record<string, number>,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }
}
