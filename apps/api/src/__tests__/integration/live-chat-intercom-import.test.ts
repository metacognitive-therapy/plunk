import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {redis} from '../../database/redis';
import {IntercomImportService} from '../../services/IntercomImportService';
import {Keys} from '../../services/keys';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {QueueService} from '../../services/QueueService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, asAgent, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new Projects()]});
const prisma = getPrismaClient();
const {session} = messengerClient(app);

const TOKEN = 'dG9rOmludGVyY29tLXRlc3QtdG9rZW4tOTk4MjE=';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

interface FakeIntercom {
  admins: {id: string; email: string}[];
  contacts: Record<string, {id: string; external_id?: string | null; email?: string | null; name?: string | null}>;
  conversations: Record<string, unknown>[];
  rateLimitOnce?: string;
}

function stubIntercom(fake: FakeIntercom) {
  const calls: {path: string; auth: string | null; version: string | null}[] = [];
  let limited = false;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({path: url.pathname + url.search, auth: headers.get('authorization'), version: headers.get('intercom-version')});
      expect(url.origin).toBe('https://api.intercom.io');
      if (headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return json({type: 'error.list', errors: [{code: 'unauthorized', message: 'Access Token Invalid'}]}, 401);
      }
      if (fake.rateLimitOnce && url.pathname === fake.rateLimitOnce && !limited) {
        limited = true;
        return json({errors: [{code: 'rate_limit_exceeded'}]}, 429, {'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000))});
      }

      const [, resource, id] = url.pathname.split('/');
      if (resource === 'me') return json({type: 'admin', id: 'me'});
      if (resource === 'admins') return json({type: 'admin.list', admins: fake.admins});
      if (resource === 'contacts' && !id) return json({type: 'list', total_count: Object.keys(fake.contacts).length});
      if (resource === 'contacts') {
        const contact = fake.contacts[id!];
        return contact ? json({type: 'contact', ...contact}) : json({errors: [{code: 'not_found', message: 'User Not Found'}]}, 404);
      }
      if (resource === 'conversations' && id) {
        const conversation = fake.conversations.find(item => item.id === id);
        return conversation ? json(conversation) : json({errors: [{code: 'not_found'}]}, 404);
      }
      if (resource === 'conversations') {
        const after = url.searchParams.get('starting_after');
        const start = after ? Number(after) : 0;
        const page = fake.conversations.slice(start, start + 2);
        const next = start + 2 < fake.conversations.length ? {page: start / 2 + 2, starting_after: String(start + 2)} : null;
        return json({
          type: 'conversation.list',
          total_count: fake.conversations.length,
          conversations: page.map(item => ({id: item.id, updated_at: item.updated_at})),
          pages: {type: 'pages', ...(next ? {next} : {})},
        });
      }
      return json({errors: [{code: 'not_found'}]}, 404);
    }),
  );
  return calls;
}

function conversation(
  id: string,
  contactId: string,
  options: {at?: number; source?: Record<string, unknown>; parts?: Record<string, unknown>[]} = {},
) {
  const at = options.at ?? NOW - 10 * DAY;
  const parts = options.parts ?? [];
  return {
    type: 'conversation',
    id,
    created_at: at,
    updated_at: (parts[parts.length - 1]?.created_at as number | undefined) ?? at,
    source: options.source ?? {body: `Hello from ${id}`, author: {type: 'user', id: contactId}, attachments: []},
    contacts: {type: 'contact.list', contacts: [{type: 'contact', id: contactId}]},
    conversation_parts: {type: 'conversation_part.list', conversation_parts: parts},
  };
}

async function workspace() {
  const {owner, project} = await messengerProject();
  const existing = await prisma.contact.create({
    data: {projectId: project.id, email: 'grace@example.com', subscribed: true, data: {plan: 'pro'}},
  });
  const fake: FakeIntercom = {
    admins: [{id: 'admin-1', email: owner.email}],
    contacts: {
      'ic-ada': {id: 'ic-ada', external_id: 'user-1', email: 'Ada@Example.com', name: 'Ada'},
      'ic-grace': {id: 'ic-grace', external_id: null, email: 'grace@example.com', name: 'Grace H'},
      'ic-ghost': {id: 'ic-ghost', external_id: null, email: null},
    },
    conversations: [
      conversation('100', 'ic-ada', {
        source: {body: '<p>My <b>export</b> fails</p>', author: {type: 'user', id: 'ic-ada'}, attachments: []},
        parts: [
          {part_type: 'assignment', body: null, created_at: NOW - 10 * DAY, author: {type: 'admin', id: 'admin-1'}},
          {part_type: 'comment', body: 'Looking into it', created_at: NOW - 10 * DAY, author: {type: 'admin', id: 'admin-1'}},
          {part_type: 'note', body: 'Known bug', created_at: NOW - 9 * DAY, author: {type: 'admin', id: 'admin-2'}},
          {
            part_type: 'comment',
            body: 'Here it is\u0007',
            created_at: NOW - 8 * DAY,
            author: {type: 'user', id: 'ic-ada'},
            attachments: [{name: 'export.csv'}],
          },
          {part_type: 'close', body: '', created_at: NOW - 7 * DAY, author: {type: 'bot', id: 'bot-1'}},
        ],
      }),
      conversation('200', 'ic-grace'),
      conversation('300', 'ic-ghost'),
      conversation('400', 'ic-deleted'),
      conversation('500', 'ic-ada', {at: NOW - 3 * 365 * DAY}),
    ],
  };
  return {owner, project, existing, fake};
}

const runImport = async (projectId: string, userId: string) => {
  const {finished} = await IntercomImportService.start(projectId, userId, TOKEN);
  await finished;
  return prisma.chatImport.findFirstOrThrow({where: {projectId}, orderBy: {startedAt: 'desc'}});
};

async function redisValues(): Promise<string[]> {
  const values: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const key of keys) {
      const type = await redis.type(key);
      if (type === 'string') values.push((await redis.get(key)) ?? '');
      else if (type === 'hash') values.push(JSON.stringify(await redis.hgetall(key)));
      else if (type === 'list') values.push(JSON.stringify(await redis.lrange(key, 0, -1)));
      else if (type === 'set') values.push(JSON.stringify(await redis.smembers(key)));
      else if (type === 'zset') values.push(JSON.stringify(await redis.zrange(key, 0, -1)));
      values.push(key);
    }
  } while (cursor !== '0');
  return values;
}

let queueSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  queueSpies = Object.getOwnPropertyNames(QueueService)
    .filter(name => typeof (QueueService as unknown as Record<string, unknown>)[name] === 'function')
    .map(name => vi.spyOn(QueueService as never, name as never).mockResolvedValue(undefined as never));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Intercom import', () => {
  it('copies conversations as closed history, once, without sending or tracking anything', async () => {
    const {owner, project, existing, fake} = await workspace();
    const calls = stubIntercom({...fake, rateLimitOnce: '/conversations/200'});

    const run = await runImport(project.id, owner.id);
    expect(run).toMatchObject({
      status: 'COMPLETED',
      totalConversations: 5,
      totalContacts: 3,
      imported: 2,
      skipped: 3,
      failed: 0,
      skipReasons: {'contact without email or user id': 1, 'contact deleted in Intercom': 1, 'past retention': 1},
    });
    expect(calls.every(call => call.version === '2.11')).toBe(true);
    expect(calls.filter(call => call.path.startsWith('/conversations/200'))).toHaveLength(2);
    expect(calls.some(call => call.path.startsWith('/conversations/500'))).toBe(false);

    const ada = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: 'user-1'}});
    expect(ada).toMatchObject({email: 'ada@example.com', subscribed: false, data: {name: 'Ada'}});
    expect(await prisma.contact.findUniqueOrThrow({where: {id: existing.id}})).toMatchObject({
      subscribed: true,
      externalId: null,
      data: {plan: 'pro'},
    });

    const imported = await prisma.conversation.findFirstOrThrow({
      where: {projectId: project.id, importedFrom: 'intercom:100'},
      include: {messages: {orderBy: {createdAt: 'asc'}}},
    });
    expect(imported).toMatchObject({
      contactId: ada.id,
      status: 'CLOSED',
      channel: 'IMPORT',
      originVisitorId: null,
      lastMessagePreview: 'Here it is [Attachment not imported: export.csv]',
      lastMessageAuthorType: 'CONTACT',
    });
    expect(imported.createdAt.getTime()).toBe((NOW - 10 * DAY) * 1000);
    expect(imported.closedAt!.getTime()).toBe((NOW - 8 * DAY) * 1000);
    expect(
      imported.messages.map(message => [message.authorType, message.kind, message.authorUserId, message.source, message.body]),
    ).toEqual([
      ['CONTACT', 'COMMENT', null, 'IMPORT', 'My export fails'],
      ['AGENT', 'COMMENT', owner.id, 'IMPORT', 'Looking into it'],
      ['AGENT', 'NOTE', null, 'IMPORT', 'Known bug'],
      ['CONTACT', 'COMMENT', null, 'IMPORT', 'Here it is\n\n[Attachment not imported: export.csv]'],
    ]);
    expect(imported.messages[1]!.createdAt.getTime()).toBeGreaterThan(imported.messages[0]!.createdAt.getTime());
    expect(
      await prisma.conversation.findFirst({where: {projectId: project.id, importedFrom: 'intercom:200'}}),
    ).toMatchObject({contactId: existing.id});

    expect(await prisma.event.count({where: {projectId: project.id}})).toBe(0);
    for (const spy of queueSpies) expect(spy).not.toHaveBeenCalled();

    const again = await runImport(project.id, owner.id);
    expect(again).toMatchObject({status: 'COMPLETED', imported: 0, skipped: 5});
    expect(again.skipReasons).toMatchObject({'already imported': 2});
    expect(await prisma.conversation.count({where: {projectId: project.id}})).toBe(2);
    expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(2);

    const runs = await prisma.chatImport.findMany({where: {projectId: project.id}});
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    expect((await redisValues()).some(value => value.includes(TOKEN))).toBe(false);
    expect(await redis.get(Keys.Messenger.importLock(project.id))).toBeNull();
  });

  it('shows imports in the Closed view and to the signed-in user, and refuses every write', async () => {
    const {owner, project, fake} = await workspace();
    stubIntercom(fake);
    await runImport(project.id, owner.id);
    vi.unstubAllGlobals();
    const conversationId = (await prisma.conversation.findFirstOrThrow({where: {importedFrom: 'intercom:100', projectId: project.id}})).id;
    const agent = asAgent(owner.id, project.id);

    const closed = await request(app).get('/conversations?view=closed').set(agent);
    expect(closed.body.data.conversations).toHaveLength(2);
    expect(closed.body.data.conversations.every((item: {unread: boolean}) => !item.unread)).toBe(true);
    expect((await request(app).get('/conversations?view=all').set(agent)).body.data.conversations).toHaveLength(0);
    const detail = await request(app).get(`/conversations/${conversationId}`).set(agent);
    expect(detail.body.data).toMatchObject({readOnly: true, channel: 'IMPORT', status: 'CLOSED'});

    for (const write of [
      request(app).post(`/conversations/${conversationId}/messages`).set(agent).send({body: 'Hi'}),
      request(app).post(`/conversations/${conversationId}/notes`).set(agent).send({body: 'Hi', mentionedUserIds: []}),
      request(app).post(`/conversations/${conversationId}/status`).set(agent).send({status: 'OPEN'}),
      request(app).post(`/conversations/${conversationId}/attachments`).set(agent).attach('file', Buffer.from('a,b\n'), 'a.csv'),
    ]) {
      const res = await write;
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.message).toBe('Imported conversations are read-only');
    }
    expect((await request(app).post(`/conversations/${conversationId}/assignee`).set(agent).send({assigneeId: owner.id})).status).toBe(200);

    const anonymous = await session(project.public);
    const anonymousList = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${anonymous.token}`);
    expect(anonymousList.body.data).toHaveLength(0);

    const secret = await MessengerSettingsService.rotateIdentitySecret(project.id);
    const boot = await request(app)
      .post('/v1/messenger/boot')
      .set('Authorization', `Bearer ${project.public}`)
      .set('Origin', API_ORIGIN)
      .send({
        visitorId: visitorId(),
        parentOrigin: ALLOWED,
        userToken: jsonwebtoken.sign({sub: 'user-1'}, secret, {algorithm: 'HS256', expiresIn: '1h'}),
      });
    const token = boot.body.data.token as string;
    const list = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`);
    expect(list.body.data.map((item: {id: string}) => item.id)).toEqual([conversationId]);
    const thread = await request(app).get(`/v1/messenger/conversations/${conversationId}`).set('Authorization', `Bearer ${token}`);
    expect(thread.body.data).toMatchObject({readOnly: true});
    expect(thread.body.data.messages.map((message: {body: string}) => message.body)).not.toContain('Known bug');

    const send = await request(app)
      .post(`/v1/messenger/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({body: 'Still broken'});
    expect(send.status).toBe(409);
    const upload = await request(app)
      .post(`/v1/messenger/conversations/${conversationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('a,b\n'), 'a.csv');
    expect(upload.status).toBe(409);
    expect(await prisma.conversationMessage.count({where: {conversationId, authorType: {not: 'SYSTEM'}}})).toBe(4);
  });

  it('refuses a token Intercom rejects and stores nothing', async () => {
    const {owner, project, fake} = await workspace();
    stubIntercom(fake);

    const res = await request(app)
      .post(`/projects/${project.id}/messenger/intercom-import`)
      .set(asAgent(owner.id, project.id))
      .send({accessToken: 'not-the-token'});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Intercom did not accept this access token/);
    expect(await prisma.chatImport.count({where: {projectId: project.id}})).toBe(0);
    expect(await redis.get(Keys.Messenger.importLock(project.id))).toBeNull();
  });

  it('starts from the API, runs one import at a time, and reports one cut off by a restart', async () => {
    const {owner, project, fake} = await workspace();
    stubIntercom(fake);
    const path = `/projects/${project.id}/messenger/intercom-import`;
    const agent = asAgent(owner.id, project.id);

    await redis.set(Keys.Messenger.importLock(project.id), 'another-run', 'EX', 60);
    expect((await request(app).post(path).set(agent).send({accessToken: TOKEN})).status).toBe(409);
    await redis.del(Keys.Messenger.importLock(project.id));

    const started = await request(app).post(path).set(agent).send({accessToken: TOKEN});
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body.data).toMatchObject({status: 'RUNNING', totalConversations: 5});
    await vi.waitFor(async () => {
      const latest = await request(app).get(path).set(agent);
      expect(latest.body.data.status).toBe('COMPLETED');
    });

    await prisma.chatImport.create({data: {projectId: project.id, source: 'intercom', status: 'RUNNING'}});
    expect((await request(app).get(path).set(agent)).body.data).toMatchObject({status: 'INTERRUPTED'});

    const member = await factories.createUser();
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: 'MEMBER'}});
    expect((await request(app).get(path).set(asAgent(member.id, project.id))).status).toBe(403);
  });
});
