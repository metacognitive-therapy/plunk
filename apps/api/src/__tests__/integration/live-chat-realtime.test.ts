import type {AddressInfo} from 'node:net';
import {createServer, type Server} from 'node:http';

import {Role} from '@plunk/db';
import {openEventStream} from '@plunk/shared/event-stream';
import request from 'supertest';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Users} from '../../controllers/Users';
import {redis} from '../../database/redis';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {ConversationService} from '../../services/ConversationService';
import {QueueService} from '../../services/QueueService';
import {RealtimeHub, realtime} from '../../services/RealtimeHub';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const hub = new RealtimeHub();
const streamOptions = {heartbeatMs: 150, hub};
const app = buildHttpApp({
  controllers: [new Messenger(streamOptions), new Conversations(streamOptions), new Users(streamOptions)],
});
const shortLivedApp = buildHttpApp({
  controllers: [new Messenger({...streamOptions, maxLifetimeMs: 300}), new Conversations(streamOptions)],
});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

let server: Server;
let shortLivedServer: Server;
let base: string;
let shortLivedBase: string;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function listen(handler: typeof app): Promise<[Server, string]> {
  const httpServer = createServer(handler);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return [httpServer, `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`];
}

interface StreamEvent {
  type: string;
  conversationId?: string;
  [key: string]: unknown;
}

async function connect(path: string, headers: Record<string, string>, origin = base) {
  const controller = new AbortController();
  const response = await fetch(origin + path, {headers, signal: controller.signal});
  expect(response.status).toBe(200);

  let raw = '';
  let ended = false;
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        raw += decoder.decode(value, {stream: true});
      }
    } catch {
      /* aborted by the test */
    }
    ended = true;
  })();

  const events = (): StreamEvent[] =>
    raw
      .split('\n\n')
      .flatMap(block => block.split('\n').filter(line => line.startsWith('data: ')))
      .map(line => JSON.parse(line.slice(6)) as StreamEvent);

  const waitFor = async (predicate: (event: StreamEvent) => boolean, timeoutMs = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = events().find(predicate);
      if (found) return found;
      await sleep(15);
    }
    throw new Error(`Timed out waiting for an event; received ${JSON.stringify(events())}`);
  };

  await waitFor(event => event.type === 'ready');
  return {
    response,
    events,
    waitFor,
    raw: () => raw,
    ended: () => ended,
    close: () => controller.abort(),
  };
}

function visitorStream(token: string, origin?: string) {
  return connect('/v1/messenger/stream', {Authorization: `Bearer ${token}`}, origin);
}

function inboxStream(userId: string, projectId: string) {
  return connect('/conversations/stream', asAgent(userId, projectId));
}

async function chatProject() {
  const {owner, project} = await messengerProject();
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  return {owner, project, visitor: {...visitor, token: started.token}, conversationId: started.conversation.id};
}

beforeAll(async () => {
  [server, base] = await listen(app);
  [shortLivedServer, shortLivedBase] = await listen(shortLivedApp);
});

afterAll(async () => {
  server.closeAllConnections();
  shortLivedServer.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => shortLivedServer.close(resolve));
  await hub.close();
  await realtime.close();
});

describe('Live chat realtime', () => {
  it('pushes a visitor message to an open inbox', async () => {
    const {owner, project} = await messengerProject();
    const inbox = await inboxStream(owner.id, project.id);
    const visitor = await session(project.public);

    const started = await startConversation(visitor.token, 'Is anyone there?');

    const event = await inbox.waitFor(e => e.type === 'message');
    expect(event).toMatchObject({
      conversationId: started.conversation.id,
      message: {authorType: 'CONTACT', body: 'Is anyone there?', kind: 'COMMENT'},
    });
    inbox.close();
  });

  it('pushes an agent reply to the visitor without exposing the agent email', async () => {
    const {owner, project, visitor, conversationId} = await chatProject();
    const stream = await visitorStream(visitor.token);

    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Hi, how can we help?'});

    const event = await stream.waitFor(e => e.type === 'message');
    expect(event).toEqual({
      type: 'message',
      conversationId,
      message: expect.objectContaining({authorType: 'AGENT', body: 'Hi, how can we help?', agent: {id: owner.id, name: null}}),
    });
    expect(stream.raw()).not.toContain(owner.email);
    stream.close();
  });

  it('never sends a visitor events for conversations their session did not start', async () => {
    const {owner, project, conversationId} = await chatProject();
    const other = await session(project.public);
    const otherStream = await visitorStream(other.token);
    const otherConversation = await startConversation(other.token, 'Mine');

    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'For the first visitor only'});
    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: otherConversation.conversation.id}});
    await ConversationService.postMessage(conversation, {
      authorType: 'AGENT',
      authorUserId: owner.id,
      kind: 'NOTE',
      body: 'Internal: VIP customer',
      source: 'DASHBOARD',
    });
    await request(app)
      .post(`/conversations/${otherConversation.conversation.id}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Your reply'});

    await otherStream.waitFor(e => e.type === 'message' && (e.message as {body: string}).body === 'Your reply');
    const messages = otherStream.events().filter(e => e.type === 'message');
    expect(messages.map(e => [e.conversationId, (e.message as {body: string}).body])).toEqual([
      [otherConversation.conversation.id, 'Mine'],
      [otherConversation.conversation.id, 'Your reply'],
    ]);
    expect(otherStream.raw()).not.toContain('For the first visitor only');
    expect(otherStream.raw()).not.toContain('Internal: VIP customer');
    otherStream.close();
  });

  it('relays typing both ways and throttles bursts', async () => {
    const {owner, project, visitor, conversationId} = await chatProject();
    await prisma.user.update({where: {id: owner.id}, data: {name: 'Maria'}});
    const inbox = await inboxStream(owner.id, project.id);
    const stream = await visitorStream(visitor.token);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/v1/messenger/conversations/${conversationId}/typing`)
        .set('Authorization', `Bearer ${visitor.token}`);
      expect(res.status).toBe(204);
    }
    await inbox.waitFor(e => e.type === 'typing');
    await sleep(100);
    expect(inbox.events().filter(e => e.type === 'typing')).toEqual([
      {type: 'typing', conversationId, author: {type: 'CONTACT'}},
    ]);

    await request(app).post(`/conversations/${conversationId}/typing`).set(asAgent(owner.id, project.id));
    expect(await stream.waitFor(e => e.type === 'typing')).toEqual({type: 'typing', conversationId, agentName: 'Maria'});
    expect(await inbox.waitFor(e => e.type === 'typing' && (e.author as {type: string}).type === 'AGENT')).toMatchObject({
      author: {type: 'AGENT', userId: owner.id, name: 'Maria'},
    });

    inbox.close();
    stream.close();
  });

  it('refuses typing into a conversation the caller cannot see', async () => {
    const {conversationId} = await chatProject();
    const {project: otherProject} = await messengerProject();
    const stranger = await session(otherProject.public);
    const strangerConversation = await startConversation(stranger.token);

    const res = await request(app)
      .post(`/v1/messenger/conversations/${conversationId}/typing`)
      .set('Authorization', `Bearer ${strangerConversation.token}`);
    expect(res.status).toBe(404);
  });

  it('tells agents when the visitor has read their reply, once', async () => {
    const {owner, project, visitor, conversationId} = await chatProject();
    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Done, all fixed'});
    const inbox = await inboxStream(owner.id, project.id);

    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/v1/messenger/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${visitor.token}`);
    }

    await inbox.waitFor(e => e.type === 'read');
    await sleep(100);
    const reads = inbox.events().filter(e => e.type === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({conversationId, reader: {type: 'CONTACT'}});
    const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    expect(stored.contactLastReadAt?.toISOString()).toBe((reads[0]!.reader as {readAt: string}).readAt);
    inbox.close();
  });

  it('keeps idle streams alive with heartbeats', async () => {
    const {visitor} = await chatProject();
    const stream = await visitorStream(visitor.token);

    await sleep(400);

    expect(stream.raw()).toContain(': ping');
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
    stream.close();
  });

  it('only lets support agents and valid sessions open a stream', async () => {
    const {project} = await chatProject();
    const member = await factories.createUser();
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER}});
    await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});

    expect((await fetch(`${base}/v1/messenger/stream`)).status).toBe(401);
    expect((await fetch(`${base}/v1/messenger/stream`, {headers: {Authorization: 'Bearer nope'}})).status).toBe(401);
    expect((await fetch(`${base}/conversations/stream`, {headers: asAgent(member.id, project.id)})).status).toBe(403);
  });

  it('delivers a mention to the mentioned agent on their personal stream', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project, conversationId} = await chatProject();
    const kari = await factories.createUser();
    await prisma.user.update({where: {id: kari.id}, data: {emailVerified: true, name: 'Kari Nordmann'}});
    await prisma.membership.create({
      data: {userId: kari.id, projectId: project.id, role: Role.MEMBER, supportAgent: true},
    });
    const kariStream = await connect('/users/@me/stream', asAgent(kari.id, project.id));
    const ownerStream = await connect('/users/@me/stream', asAgent(owner.id, project.id));

    const note = await ConversationService.addNote(project.id, owner.id, conversationId, {
      body: '@Kari Nordmann can you look at this?',
      mentionedUserIds: [kari.id],
    });
    await ChatNotificationService.process({type: 'mention', messageId: note.id});

    const mention = await kariStream.waitFor(event => event.type === 'mention');
    expect(mention).toMatchObject({projectId: project.id, conversationId, messageId: note.id});
    await sleep(100);
    expect(ownerStream.events().map(event => event.type)).toEqual(['ready']);
    expect((await fetch(`${base}/users/@me/stream`)).status).toBe(401);

    kariStream.close();
    ownerStream.close();
    vi.restoreAllMocks();
  });

  it('delivers a message published by one instance to a stream held by another', async () => {
    const otherInstance = new RealtimeHub();
    const channel = `realtime:test:${crypto.randomUUID()}`;
    const received: string[][] = [[], []];
    await hub.subscribe(channel, frame => received[0]!.push(frame));
    await otherInstance.subscribe(channel, frame => received[1]!.push(frame));

    await RealtimeHub.publish(channel, {type: 'conversation', conversationId: 'c1'});

    await expect.poll(() => received.map(list => list.length)).toEqual([1, 1]);
    expect(received[1]![0]!.split('\n')[1]).toBe('{"type":"conversation","conversationId":"c1"}');
    await otherInstance.close();
  });

  it('serves any number of streams over a single Redis connection', async () => {
    const {owner, project} = await messengerProject();
    const visitors = await Promise.all([1, 2, 3].map(() => session(project.public)));
    const streams = await Promise.all([
      ...visitors.map(visitor => visitorStream(visitor.token)),
      inboxStream(owner.id, project.id),
      inboxStream(owner.id, project.id),
    ]);

    const clients = (await redis.client('LIST')) as string;
    const connections = clients.split('\n').filter(line => line.includes(`name=${hub.connectionName}`));
    expect(connections).toHaveLength(1);

    const visitor = await session(project.public);
    await startConversation(visitor.token);
    for (const inbox of streams.slice(3)) {
      await inbox.waitFor(e => e.type === 'message');
    }
    streams.forEach(stream => stream.close());
  });

  it('ends open streams when the Redis subscriber reconnects, so clients resync', async () => {
    const {owner, project, visitor} = await chatProject();
    const stream = await visitorStream(visitor.token);

    const clients = (await redis.client('LIST')) as string;
    const id = clients
      .split('\n')
      .find(line => line.includes(`name=${hub.connectionName}`))!
      .match(/id=(\d+)/)![1]!;
    await redis.client('KILL', 'ID', id);

    await expect.poll(() => stream.ended(), {timeout: 5000}).toBe(true);

    const inbox = await inboxStream(owner.id, project.id);
    const other = await session(project.public);
    await startConversation(other.token);
    await inbox.waitFor(event => event.type === 'message');
    inbox.close();
  });

  it('recycles streams and the client reconnects and resyncs', async () => {
    const {owner, project, visitor, conversationId} = await chatProject();
    const events: StreamEvent[] = [];
    let opens = 0;
    const client = openEventStream({
      url: `${shortLivedBase}/v1/messenger/stream`,
      headers: () => ({Authorization: `Bearer ${visitor.token}`}),
      onEvent: data => events.push(JSON.parse(data) as StreamEvent),
      onOpen: () => {
        opens += 1;
      },
    });

    await expect.poll(() => opens, {timeout: 4000}).toBeGreaterThanOrEqual(2);
    expect(events.filter(e => e.type === 'ready').length).toBeGreaterThanOrEqual(2);

    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Sent while you were away'});
    const thread = await request(app)
      .get(`/v1/messenger/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${visitor.token}`);
    expect(thread.body.data.messages.map((m: {body: string}) => m.body)).toContain('Sent while you were away');
    client.close();
  });

  it('stops retrying when the stream is refused', async () => {
    const {project} = await chatProject();
    const member = await factories.createUser();
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER}});
    await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});

    let refused: number | null = null;
    const client = openEventStream({
      url: `${base}/conversations/stream`,
      headers: () => asAgent(member.id, project.id),
      onEvent: () => undefined,
      onRefused: status => {
        refused = status;
      },
    });

    await expect.poll(() => refused).toBe(403);
    client.close();
  });
});
