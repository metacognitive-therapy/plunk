import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {Role} from '@plunk/db';
import {CONTACT_IDENTITY_TYPES} from '@plunk/shared';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, JWT_SECRET} from '../../app/constants';
import {widgetRouter} from '../../app/widget';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {jwt} from '../../middleware/auth';
import {MembershipService} from '../../services/MembershipService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {buildHttpApp} from '../helpers/httpApp';

const ALLOWED = 'https://www.example.com';
const API_ORIGIN = new URL(API_URI).origin;

const app = buildHttpApp({controllers: [new Messenger(), new Conversations()]});
const prisma = getPrismaClient();

function visitorId(): string {
  return `v_${randomUUID().replace(/-/g, '')}`;
}

async function messengerProject(settings: {enabled?: boolean; allowedOrigins?: string[]} = {}) {
  const {user: owner, project} = await factories.createUserWithProject();
  await prisma.membership.update({
    where: {userId_projectId: {userId: owner.id, projectId: project.id}},
    data: {role: Role.OWNER},
  });
  await prisma.user.update({where: {id: owner.id}, data: {emailVerified: true}});
  await MessengerSettingsService.update(project.id, {
    enabled: settings.enabled ?? true,
    allowedOrigins: settings.allowedOrigins ?? [ALLOWED],
  });
  return {owner, project};
}

function boot(publicKey: string, body: {visitorId: string; parentOrigin?: string}, origin?: string) {
  const req = request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${publicKey}`);
  if (origin) req.set('Origin', origin);
  return req.send(body);
}

async function session(publicKey: string, visitor = visitorId()) {
  const res = await boot(publicKey, {visitorId: visitor, parentOrigin: ALLOWED}, API_ORIGIN);
  expect(res.status).toBe(200);
  return {token: res.body.data.token as string, visitor};
}

async function startConversation(token: string, body = 'Hello, I need help') {
  const res = await request(app)
    .post('/v1/messenger/conversations')
    .set('Authorization', `Bearer ${token}`)
    .send({body});
  expect(res.status).toBe(201);
  return res.body.data as {token: string; conversation: {id: string; messages: {body: string}[]}};
}

function asAgent(userId: string, projectId: string) {
  return {Cookie: `next_token=${jwt.sign(userId)}`, 'X-Project-Id': projectId};
}

describe('Live chat core', () => {
  describe('boot', () => {
    it('refuses a project whose messenger is disabled', async () => {
      const {project} = await messengerProject({enabled: false});
      const res = await boot(project.public, {visitorId: visitorId()});
      expect(res.status).toBe(403);
    });

    it('refuses a project with an empty allowlist', async () => {
      const {project} = await messengerProject({allowedOrigins: []});
      const res = await boot(project.public, {visitorId: visitorId()});
      expect(res.status).toBe(403);
    });

    it('refuses a request from an origin that is not allowlisted', async () => {
      const {project} = await messengerProject();
      const res = await boot(project.public, {visitorId: visitorId()}, 'https://evil.example.net');
      expect(res.status).toBe(403);
    });

    it('refuses an embedding page that is not allowlisted', async () => {
      const {project} = await messengerProject();
      const res = await boot(project.public, {visitorId: visitorId(), parentOrigin: 'https://evil.example.net'}, API_ORIGIN);
      expect(res.status).toBe(403);
    });

    it('accepts the frame origin, an allowlisted origin, and a standalone frame', async () => {
      const {project} = await messengerProject();
      expect((await boot(project.public, {visitorId: visitorId(), parentOrigin: ALLOWED}, API_ORIGIN)).status).toBe(200);
      expect((await boot(project.public, {visitorId: visitorId()}, ALLOWED)).status).toBe(200);
      expect((await boot(project.public, {visitorId: visitorId()}, API_ORIGIN)).status).toBe(200);
    });

    it('refuses an unknown public key and a malformed visitor id', async () => {
      const {project} = await messengerProject();
      expect((await boot('pk_unknown', {visitorId: visitorId()})).status).toBe(401);
      expect((await boot(project.public, {visitorId: 'short'})).status).toBe(422);
    });

    it('returns the project brand and language', async () => {
      const {project} = await messengerProject();
      await prisma.project.update({where: {id: project.id}, data: {brandName: 'Support Co', language: 'nl'}});
      const res = await boot(project.public, {visitorId: visitorId()});
      expect(res.body.data.project).toEqual({name: 'Support Co', logoUrl: null, language: 'nl'});
    });
  });

  describe('visitor conversations', () => {
    it('does not create a contact on boot, and creates an unsubscribed lead on the first message', async () => {
      const {project} = await messengerProject();
      const {token, visitor} = await session(project.public);
      expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(0);

      await startConversation(token);

      const contacts = await prisma.contact.findMany({where: {projectId: project.id}, include: {identities: true}});
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({email: null, subscribed: false});
      expect(contacts[0]!.identities).toEqual([
        expect.objectContaining({type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: visitor}),
      ]);
    });

    it('resumes the same contact when the visitor boots again', async () => {
      const {project} = await messengerProject();
      const first = await session(project.public);
      const started = await startConversation(first.token);

      const again = await session(project.public, first.visitor);
      const second = await startConversation(again.token, 'Another question');

      const conversations = await prisma.conversation.findMany({where: {projectId: project.id}});
      expect(conversations).toHaveLength(2);
      expect(new Set(conversations.map(c => c.contactId)).size).toBe(1);
      expect(second.conversation.id).not.toBe(started.conversation.id);
      expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(1);
    });

    it('lets a visitor send messages and read them back', async () => {
      const {project} = await messengerProject();
      const {token} = await session(project.public);
      const {conversation} = await startConversation(token, 'First');

      const sent = await request(app)
        .post(`/v1/messenger/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({body: 'Second'});
      expect(sent.status).toBe(201);

      const thread = await request(app)
        .get(`/v1/messenger/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(thread.body.data.messages.map((m: {body: string}) => m.body)).toEqual(['First', 'Second']);

      const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}});
      expect(stored.lastMessagePreview).toBe('Second');
      expect(stored.lastContactMessageAt).not.toBeNull();
    });

    it('scopes a session to the conversations it originated', async () => {
      const {project} = await messengerProject();
      const alice = await session(project.public);
      const bob = await session(project.public);
      const {conversation} = await startConversation(alice.token);

      const list = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${bob.token}`);
      expect(list.body.data).toEqual([]);

      const read = await request(app)
        .get(`/v1/messenger/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${bob.token}`);
      expect(read.status).toBe(404);

      const write = await request(app)
        .post(`/v1/messenger/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({body: 'Hijack'});
      expect(write.status).toBe(404);

      const own = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${alice.token}`);
      expect(own.body.data.map((c: {id: string}) => c.id)).toEqual([conversation.id]);
    });

    it('rejects a session from another project', async () => {
      const a = await messengerProject();
      const b = await messengerProject();
      const visitorA = await session(a.project.public);
      const {conversation} = await startConversation(visitorA.token);

      const visitor = visitorA.visitor;
      const otherProject = await session(b.project.public, visitor);
      const res = await request(app)
        .get(`/v1/messenger/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${otherProject.token}`);
      expect(res.status).toBe(404);
    });

    it('rejects an expired session, a dashboard token, and a forged token', async () => {
      const {project, owner} = await messengerProject();
      const {token} = await session(project.public);

      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
      const expired = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`);
      vi.useRealTimers();
      expect(expired.status).toBe(401);

      const dashboard = await request(app)
        .get('/v1/messenger/conversations')
        .set('Authorization', `Bearer ${jwt.sign(owner.id)}`);
      expect(dashboard.status).toBe(401);

      const forged = jsonwebtoken.sign({pid: project.id, vid: visitorId(), cid: null, ver: false}, JWT_SECRET, {
        audience: 'plunk-messenger',
      });
      const forgedRes = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${forged}`);
      expect(forgedRes.status).toBe(401);
    });

    it('cuts off live sessions when the messenger is disabled', async () => {
      const {project} = await messengerProject();
      const {token} = await session(project.public);
      await MessengerSettingsService.update(project.id, {enabled: false});

      const res = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('marks the conversation read by the contact', async () => {
      const {project} = await messengerProject();
      const {token} = await session(project.public);
      const {conversation} = await startConversation(token);

      const res = await request(app)
        .post(`/v1/messenger/conversations/${conversation.id}/read`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}});
      expect(stored.contactLastReadAt).not.toBeNull();
    });
  });

  describe('inbox', () => {
    let owner: {id: string};
    let project: {id: string; public: string};

    beforeEach(async () => {
      ({owner, project} = await messengerProject());
    });

    it('shows a visitor conversation to the owner, who replies, and the visitor sees the reply', async () => {
      const visitor = await session(project.public);
      const {conversation} = await startConversation(visitor.token, 'Is anyone there?');

      const list = await request(app).get('/conversations').set(asAgent(owner.id, project.id));
      expect(list.status).toBe(200);
      expect(list.body.data.conversations).toEqual([
        expect.objectContaining({id: conversation.id, unread: true, lastMessage: {body: 'Is anyone there?', authorType: 'CONTACT'}}),
      ]);

      const reply = await request(app)
        .post(`/conversations/${conversation.id}/messages`)
        .set(asAgent(owner.id, project.id))
        .send({body: 'Yes, how can I help?'});
      expect(reply.status).toBe(201);

      const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}});
      expect(stored.firstResponseAt).not.toBeNull();

      const seen = await request(app)
        .get(`/v1/messenger/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${visitor.token}`);
      const last = seen.body.data.messages.at(-1);
      expect(last).toMatchObject({authorType: 'AGENT', body: 'Yes, how can I help?'});
      expect(last.agent).toEqual({id: owner.id, name: null});
      expect(JSON.stringify(seen.body)).not.toContain(owner.email);

      await prisma.user.update({where: {id: owner.id}, data: {name: 'Maria'}});
      const named = await request(app)
        .get(`/v1/messenger/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${visitor.token}`);
      expect(named.body.data.messages.at(-1).agent).toEqual({id: owner.id, name: 'Maria'});

      const visitorList = await request(app)
        .get('/v1/messenger/conversations')
        .set('Authorization', `Bearer ${visitor.token}`);
      expect(visitorList.body.data[0].unread).toBe(true);

      const afterReply = await request(app).get('/conversations').set(asAgent(owner.id, project.id));
      expect(afterReply.body.data.conversations[0].unread).toBe(false);
    });

    it('keeps firstResponseAt at the first agent reply', async () => {
      const visitor = await session(project.public);
      const {conversation} = await startConversation(visitor.token);

      await request(app).post(`/conversations/${conversation.id}/messages`).set(asAgent(owner.id, project.id)).send({body: 'One'});
      const first = (await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}})).firstResponseAt;
      await request(app).post(`/conversations/${conversation.id}/messages`).set(asAgent(owner.id, project.id)).send({body: 'Two'});
      const after = (await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}})).firstResponseAt;

      expect(after?.getTime()).toBe(first?.getTime());
    });

    it('records the agent read and clears unread', async () => {
      const visitor = await session(project.public);
      const {conversation} = await startConversation(visitor.token);

      const read = await request(app).post(`/conversations/${conversation.id}/read`).set(asAgent(owner.id, project.id));
      expect(read.status).toBe(200);
      expect(await prisma.conversationRead.count({where: {userId: owner.id, conversationId: conversation.id}})).toBe(1);

      const thread = await request(app).get(`/conversations/${conversation.id}`).set(asAgent(owner.id, project.id));
      expect(thread.body.data.unread).toBe(false);
      expect(thread.body.data.messages).toHaveLength(1);
    });

    it('refuses every inbox route to a member who is not a support agent, until the flag is set', async () => {
      const visitor = await session(project.public);
      const {conversation} = await startConversation(visitor.token);
      const member = await factories.createUser();
      await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});
      await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER}});
      const headers = asAgent(member.id, project.id);

      const responses = await Promise.all([
        request(app).get('/conversations').set(headers),
        request(app).get(`/conversations/${conversation.id}`).set(headers),
        request(app).post(`/conversations/${conversation.id}/messages`).set(headers).send({body: 'Hi'}),
        request(app).post(`/conversations/${conversation.id}/read`).set(headers),
      ]);
      expect(responses.map(r => r.status)).toEqual([403, 403, 403, 403]);

      await MembershipService.setSupportAgent(project.id, member.id, true);
      expect((await request(app).get('/conversations').set(headers)).status).toBe(200);

      await MembershipService.setSupportAgent(project.id, member.id, false);
      expect((await request(app).get('/conversations').set(headers)).status).toBe(403);
    });

    it('refuses a secret API key, since replies need a person', async () => {
      const full = await prisma.project.findUniqueOrThrow({where: {id: project.id}});
      const res = await request(app).get('/conversations').set('Authorization', `Bearer ${full.secret}`);
      expect(res.status).toBe(403);
    });

    it('does not let an agent read another project’s conversation', async () => {
      const other = await messengerProject();
      const visitor = await session(other.project.public);
      const {conversation} = await startConversation(visitor.token);

      const res = await request(app).get(`/conversations/${conversation.id}`).set(asAgent(owner.id, project.id));
      expect(res.status).toBe(404);
    });

    it('paginates with a cursor, newest first, without duplicates or gaps', async () => {
      const contact = await factories.createContact({projectId: project.id, email: null});
      const base = Date.now();
      const created = await Promise.all(
        Array.from({length: 7}, (_, i) =>
          prisma.conversation.create({
            data: {
              projectId: project.id,
              contactId: contact.id,
              lastMessageAt: new Date(base - (i % 3) * 1000),
              lastContactMessageAt: new Date(base),
            },
          }),
        ),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `/conversations?view=all&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await request(app).get(query).set(asAgent(owner.id, project.id));
        expect(res.status).toBe(200);
        seen.push(...res.body.data.conversations.map((c: {id: string}) => c.id));
        cursor = res.body.data.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(created.length);
      expect(new Set(seen).size).toBe(created.length);

      const order = await prisma.conversation.findMany({
        where: {projectId: project.id},
        orderBy: [{lastMessageAt: 'desc'}, {id: 'desc'}],
        select: {id: true},
      });
      expect(seen).toEqual(order.map(c => c.id));
    });

    it('splits conversations into views', async () => {
      const contact = await factories.createContact({projectId: project.id, email: null});
      const make = (data: {status?: 'OPEN' | 'CLOSED'; assigneeId?: string | null}) =>
        prisma.conversation.create({data: {projectId: project.id, contactId: contact.id, ...data}});
      const unassigned = await make({});
      const mine = await make({assigneeId: owner.id});
      const closed = await make({status: 'CLOSED'});

      const ids = async (view: string) =>
        (await request(app).get(`/conversations?view=${view}`).set(asAgent(owner.id, project.id))).body.data.conversations.map(
          (c: {id: string}) => c.id,
        );

      expect(await ids('unassigned')).toEqual([unassigned.id]);
      expect(await ids('mine')).toEqual([mine.id]);
      expect(await ids('closed')).toEqual([closed.id]);
      expect((await ids('all')).sort()).toEqual([unassigned.id, mine.id].sort());
    });

    it('reopens a closed conversation when the visitor writes again', async () => {
      const visitor = await session(project.public);
      const {conversation} = await startConversation(visitor.token);
      await prisma.conversation.update({where: {id: conversation.id}, data: {status: 'CLOSED', closedAt: new Date()}});

      await request(app)
        .post(`/v1/messenger/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${visitor.token}`)
        .send({body: 'Still broken'});

      const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversation.id}});
      expect(stored).toMatchObject({status: 'OPEN', closedAt: null});
    });
  });

  describe('inbox list query plan', () => {
    it('is served by the project/status/lastMessageAt index on the first and later pages', async () => {
      const {project} = await messengerProject();
      const plan = async (sql: string, params: unknown[]) =>
        prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
          const rows = await tx.$queryRawUnsafe<{'QUERY PLAN': string}[]>(`EXPLAIN ${sql}`, ...params);
          return rows.map(row => row['QUERY PLAN']).join('\n');
        });

      const firstPage = await plan(
        `SELECT id FROM conversations WHERE "projectId" = $1 AND status = 'OPEN'
         ORDER BY "lastMessageAt" DESC, id DESC LIMIT 31`,
        [project.id],
      );
      expect(firstPage).toContain('conversations_projectId_status_lastMessageAt_idx');

      const laterPage = await plan(
        `SELECT id FROM conversations WHERE "projectId" = $1 AND status = 'OPEN'
         AND ("lastMessageAt" < $2 OR ("lastMessageAt" = $2 AND id < $3))
         ORDER BY "lastMessageAt" DESC, id DESC LIMIT 31`,
        [project.id, new Date(), randomUUID()],
      );
      expect(laterPage).toContain('conversations_projectId_status_lastMessageAt_idx');
    });
  });
});

describe('Widget frame headers', () => {
  let widgetApp: ReturnType<typeof buildHttpApp>;

  beforeAll(async () => {
    const dist = await mkdtemp(path.join(tmpdir(), 'plunk-widget-'));
    await mkdir(path.join(dist, 'assets'));
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(dist, 'assets', 'index-abc.js'), 'console.log(1)');
    widgetApp = buildHttpApp({routers: {'/widget': widgetRouter({distDir: dist})}});
  });

  it('lets only the project allowlist frame the messenger', async () => {
    const {project} = await messengerProject({allowedOrigins: [ALLOWED, 'https://example.com']});
    const res = await request(widgetApp).get(`/widget/?key=${project.public}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${ALLOWED} https://example.com`);
    expect(res.headers['content-security-policy']).not.toContain("frame-ancestors 'self'");
  });

  it('forbids framing for an unknown key or a disabled messenger', async () => {
    const {project} = await messengerProject({enabled: false});
    for (const key of ['pk_unknown', project.public]) {
      const res = await request(widgetApp).get(`/widget/?key=${key}`);
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('serves assets so other origins can load them', async () => {
    const res = await request(widgetApp).get('/widget/assets/index-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});
