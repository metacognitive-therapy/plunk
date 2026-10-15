import {CONTACT_IDENTITY_TYPES} from '@plunk/shared';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {ContactService} from '../../services/ContactService';
import {PUSH_RECEIPT_DELAY_MS, PUSH_TOKENS_PER_CONTACT} from '../../services/ContactPushService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {QueueService} from '../../services/QueueService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, asAgent, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

const pushToken = (name: string) => `ExponentPushToken[${name.padEnd(12, 'x')}]`;

let queued: Parameters<typeof QueueService.queueChatNotification>[];

beforeEach(() => {
  queued = [];
  vi.spyOn(QueueService, 'queueChatNotification').mockImplementation(async (...args) => {
    queued.push(args);
    return undefined as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubExpo(answers: {tickets?: unknown[]; receipts?: Record<string, unknown>; status?: number}) {
  const calls: {path: string; body: unknown; auth: string | null}[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.split('/').pop()!;
    calls.push({path, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization')});
    if (answers.status) {
      return new Response('{"errors":[{"code":"INTERNAL"}]}', {status: answers.status});
    }
    const data = path === 'send' ? answers.tickets : answers.receipts;
    return new Response(JSON.stringify({data}), {status: 200, headers: {'Content-Type': 'application/json'}});
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function signedInChat(sub = 'user-1') {
  const {owner, project} = await messengerProject();
  const secret = await MessengerSettingsService.rotateIdentitySecret(project.id);
  const signIn = (user: string) =>
    request(app)
      .post('/v1/messenger/boot')
      .set('Authorization', `Bearer ${project.public}`)
      .set('Origin', API_ORIGIN)
      .send({
        visitorId: visitorId(),
        parentOrigin: ALLOWED,
        userToken: jsonwebtoken.sign({sub: user}, secret, {algorithm: 'HS256', expiresIn: '1h'}),
      })
      .then(res => {
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data.token as string;
      });
  const token = await signIn(sub);
  const started = await startConversation(token, 'The app crashes on launch');
  const contact = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: sub}});
  return {owner, project, token, signIn, contact, conversationId: started.conversation.id};
}

function register(token: string, value: string, path = 'push-token') {
  return request(app).post(`/v1/messenger/${path}`).set('Authorization', `Bearer ${token}`).send({token: value});
}

async function reply(chat: Awaited<ReturnType<typeof signedInChat>>, body = 'We are on it') {
  const res = await request(app)
    .post(`/conversations/${chat.conversationId}/messages`)
    .set(asAgent(chat.owner.id, chat.project.id))
    .send({body});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const tokensOf = (contactId: string) =>
  prisma.contactIdentity
    .findMany({where: {contactId, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN}, select: {value: true}})
    .then(rows => rows.map(row => row.value).sort());

describe('Registering push tokens', () => {
  it('stores the token on the signed-in contact and removes it on request', async () => {
    const chat = await signedInChat();

    expect((await register(chat.token, pushToken('phone'))).status).toBe(200);
    expect(await tokensOf(chat.contact.id)).toEqual([pushToken('phone')]);

    expect((await register(chat.token, pushToken('phone'), 'push-token/remove')).status).toBe(200);
    expect(await tokensOf(chat.contact.id)).toEqual([]);
  });

  it('refuses anonymous sessions and anything but an Expo token', async () => {
    const chat = await signedInChat();
    const anonymous = await session(chat.project.public);

    expect((await register(anonymous.token, pushToken('phone'))).status).toBe(403);
    const raw = await register(chat.token, 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9');
    expect(raw.status).toBe(422);
    expect(JSON.stringify(raw.body)).toMatch(/Expo push token/);
    expect(await prisma.contactIdentity.count({where: {projectId: chat.project.id, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN}})).toBe(0);
  });

  it('moves a device to whoever signs in on it, and never removes another contact token', async () => {
    const chat = await signedInChat('user-a');
    await register(chat.token, pushToken('shared'));
    const other = await chat.signIn('user-b');
    const userB = await prisma.contact.findFirstOrThrow({where: {projectId: chat.project.id, externalId: 'user-b'}});

    await register(other, pushToken('shared'));
    expect(await tokensOf(chat.contact.id)).toEqual([]);
    expect(await tokensOf(userB.id)).toEqual([pushToken('shared')]);

    await register(chat.token, pushToken('shared'), 'push-token/remove');
    expect(await tokensOf(userB.id)).toEqual([pushToken('shared')]);
  });

  it(`keeps the ${PUSH_TOKENS_PER_CONTACT} most recently seen devices`, async () => {
    const chat = await signedInChat();
    for (let device = 0; device <= PUSH_TOKENS_PER_CONTACT; device++) {
      await register(chat.token, pushToken(`device${device}`));
    }
    const tokens = await tokensOf(chat.contact.id);
    expect(tokens).toHaveLength(PUSH_TOKENS_PER_CONTACT);
    expect(tokens).not.toContain(pushToken('device0'));
  });

  it('drops the tokens when the contact is anonymized', async () => {
    const chat = await signedInChat('user-erased');
    await register(chat.token, pushToken('phone'));

    await ContactService.anonymizeByExternalId(chat.project.id, 'user-erased');

    expect(await prisma.contactIdentity.count({where: {projectId: chat.project.id, type: CONTACT_IDENTITY_TYPES.PUSH_TOKEN}})).toBe(0);
  });
});

describe('Pushing agent replies', () => {
  it('pushes a reply to every registered device and checks the receipts later', async () => {
    const chat = await signedInChat();
    await register(chat.token, pushToken('phone'));
    await register(chat.token, pushToken('tablet'));
    const messageId = await reply(chat, 'Fixed in the next release');
    expect(queued).toContainEqual([{type: 'contact_push', messageId}]);

    const calls = stubExpo({tickets: [{status: 'ok', id: 'receipt-1'}, {status: 'ok', id: 'receipt-2'}]});
    expect(await ChatNotificationService.process({type: 'contact_push', messageId})).toEqual({sent: 2});

    expect(calls).toHaveLength(1);
    const sent = calls[0]!.body as {to: string; title: string; body: string; data: unknown}[];
    expect(sent.map(push => push.to).sort()).toEqual([pushToken('phone'), pushToken('tablet')].sort());
    expect(sent[0]).toMatchObject({
      body: expect.stringMatching(/: Fixed in the next release$/),
      data: {plunk: {conversationId: chat.conversationId}},
    });
    const receipts = Object.fromEntries(sent.map((push, index) => [`receipt-${index + 1}`, push.to]));
    expect(queued).toContainEqual([
      {type: 'push_receipts', messageId, projectId: chat.project.id, receipts},
      {delay: PUSH_RECEIPT_DELAY_MS},
    ]);
  });

  it('pushes nothing for internal notes', async () => {
    const chat = await signedInChat();
    await register(chat.token, pushToken('phone'));
    const note = await request(app)
      .post(`/conversations/${chat.conversationId}/notes`)
      .set(asAgent(chat.owner.id, chat.project.id))
      .send({body: 'Probably the cache again'});
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    expect(queued.map(([job]) => job.type)).not.toContain('contact_push');

    const calls = stubExpo({tickets: []});
    expect(await ChatNotificationService.process({type: 'contact_push', messageId: note.body.data.id})).toEqual({sent: 0});
    expect(calls).toHaveLength(0);
  });

  it('removes a token Expo reports as unregistered, at send or in its receipt', async () => {
    const chat = await signedInChat();
    await register(chat.token, pushToken('gone'));
    const first = await reply(chat);
    stubExpo({tickets: [{status: 'error', details: {error: 'DeviceNotRegistered'}}]});
    expect(await ChatNotificationService.process({type: 'contact_push', messageId: first})).toEqual({sent: 0});
    expect(await tokensOf(chat.contact.id)).toEqual([]);

    await register(chat.token, pushToken('uninstalled'));
    await register(chat.token, pushToken('fine'));
    stubExpo({
      receipts: {
        'receipt-1': {status: 'error', details: {error: 'DeviceNotRegistered'}},
        'receipt-2': {status: 'ok'},
      },
    });
    const result = await ChatNotificationService.process({
      type: 'push_receipts',
      messageId: first,
      projectId: chat.project.id,
      receipts: {'receipt-1': pushToken('uninstalled'), 'receipt-2': pushToken('fine')},
    });
    expect(result).toEqual({removed: 1});
    expect(await tokensOf(chat.contact.id)).toEqual([pushToken('fine')]);
  });

  it('fails the job for a retry only when Expo could not take the push', async () => {
    const chat = await signedInChat();
    await register(chat.token, pushToken('phone'));
    const messageId = await reply(chat);

    stubExpo({status: 503});
    await expect(ChatNotificationService.process({type: 'contact_push', messageId})).rejects.toThrow(/503/);

    stubExpo({status: 400});
    expect(await ChatNotificationService.process({type: 'contact_push', messageId})).toEqual({sent: 0});
  });

  it('does not push replies in a chat an anonymous visitor started, even once it is on the contact', async () => {
    const chat = await signedInChat();
    await register(chat.token, pushToken('phone'));
    const anonymous = await session(chat.project.public);
    const started = await startConversation(anonymous.token, 'I am not really this user');
    await prisma.conversation.update({where: {id: started.conversation.id}, data: {contactId: chat.contact.id}});

    const res = await request(app)
      .post(`/conversations/${started.conversation.id}/messages`)
      .set(asAgent(chat.owner.id, chat.project.id))
      .send({body: 'Here is your account detail'});
    expect(res.status).toBe(201);

    const calls = stubExpo({tickets: [{status: 'ok', id: 'receipt-1'}]});
    expect(await ChatNotificationService.process({type: 'contact_push', messageId: res.body.data.id})).toEqual({sent: 0});
    expect(calls).toHaveLength(0);
  });
});
