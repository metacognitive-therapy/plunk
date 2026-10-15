import type {EventStreamTransport} from '@plunk/shared/event-stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {MessengerController} from '../controller';
import type {ConversationSummary, KeyValueStorage, Message, StreamEvent} from '../types';

const API = 'https://api.example.com';
const KEY = 'pk_test';

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function summary(id: string, unread = false): ConversationSummary {
  return {id, status: 'OPEN', lastMessageAt: '2026-10-15T10:00:00.000Z', lastMessage: {body: 'hi', authorType: 'CONTACT'}, unread};
}

function agentMessage(id: string): Message {
  return {id, authorType: 'AGENT', agent: {id: 'a1', name: 'Kari'}, body: 'Hello!', attachments: [], createdAt: '2026-10-15T10:05:00.000Z'};
}

/** A fake messenger API: conversations per visitor (anonymous) or per user token subject (verified). */
function fakeApi() {
  const calls: Call[] = [];
  const conversationsBySubject = new Map<string, ConversationSummary[]>();
  let sessionCounter = 0;
  const sessions = new Map<string, string>();
  let rejectSession: string | null = null;

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API, '');
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '') ?? null;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({method: init.method ?? 'GET', path, auth, body});
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(status < 400 ? {success: true, data} : {success: false, error: {message: String(data)}}), {status});

    if (path === '/v1/messenger/boot') {
      const userToken = body?.userToken as string | undefined;
      if (userToken === 'expired') {
        return json(401, 'The user token is invalid or has expired');
      }
      const subject = userToken ? `user:${userToken.split('.')[0]}` : `visitor:${String(body?.visitorId)}`;
      const token = `session-${++sessionCounter}`;
      sessions.set(token, subject);
      return json(200, {
        token,
        expiresAt: '2026-10-16T00:00:00.000Z',
        project: {name: 'Support', logoUrl: null, language: 'en'},
        appearance: {accentColor: '#0ea5e9', launcherPosition: 'RIGHT', greeting: null, team: []},
        availability: {replyTime: 'FEW_MINUTES', officeHours: null},
        serverTime: new Date().toISOString(),
        visitor: {hasEmail: Boolean(userToken), verified: Boolean(userToken)},
        turnstileSiteKey: null,
      });
    }
    const subject = auth ? sessions.get(auth) : undefined;
    if (!subject || auth === rejectSession) {
      return json(401, 'Session expired');
    }
    if (path === '/v1/messenger/conversations') {
      return json(200, conversationsBySubject.get(subject) ?? []);
    }
    if (path.startsWith('/v1/messenger/push-token')) {
      return json(200, undefined);
    }
    if (path === '/v1/messenger/user' || path === '/v1/messenger/events') {
      const attributes = (body?.attributes ?? {}) as Record<string, unknown>;
      return 'favourite_colour' in attributes ? json(422, 'Not a declared user attribute: favourite_colour') : json(200, undefined);
    }
    if (path.endsWith('/read')) {
      return new Response(null, {status: 204});
    }
    return json(404, 'Not found');
  });

  return {
    calls,
    fetchMock,
    conversationsBySubject,
    expireSession(token: string) {
      rejectSession = token;
    },
  };
}

/** A transport the test feeds: every connection gets the events pushed through `emit`. */
function fakeTransport() {
  const listeners = new Set<(chunk: string) => void>();
  const transport: EventStreamTransport = async request => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const push = (chunk: string) => {
      queue.push(chunk);
      wake?.();
    };
    listeners.add(push);
    request.signal.addEventListener('abort', () => {
      listeners.delete(push);
      wake?.();
    });
    return {
      status: 200,
      ok: true,
      chunks: (async function* () {
        while (!request.signal.aborted) {
          if (queue.length) {
            yield queue.shift()!;
          } else {
            await new Promise<void>(resolve => {
              wake = resolve;
            });
          }
        }
      })(),
    };
  };
  return {
    transport,
    emit(event: StreamEvent) {
      for (const listener of listeners) {
        listener(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
    get connections() {
      return listeners.size;
    },
  };
}

function memoryStorage(): KeyValueStorage & {values: Map<string, string>} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => void values.set(key, value),
    removeItem: async key => void values.delete(key),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

describe('MessengerController', () => {
  let api: ReturnType<typeof fakeApi>;
  let stream: ReturnType<typeof fakeTransport>;
  let storage: ReturnType<typeof memoryStorage>;
  let controller: MessengerController;

  beforeEach(() => {
    api = fakeApi();
    stream = fakeTransport();
    storage = memoryStorage();
    vi.stubGlobal('fetch', api.fetchMock);
    controller = new MessengerController({apiUrl: `${API}/`, publicKey: KEY, storage}, stream.transport);
  });

  afterEach(async () => {
    await controller.logout();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('boots a signed-in user with a token from the callback and lists their conversations', async () => {
    api.conversationsBySubject.set('user:alice', [summary('c1'), summary('c2', true)]);
    const getUserToken = vi.fn(async () => 'alice.token');

    await controller.loginUser({getUserToken});

    const boot = api.calls.find(call => call.path === '/v1/messenger/boot')!;
    expect(boot.auth).toBe(KEY);
    expect(boot.body).toMatchObject({userToken: 'alice.token'});
    expect(boot.body?.visitorId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(controller.getState()).toMatchObject({session: 'verified', status: 'ready'});
    expect(controller.getState().conversations.map(conversation => conversation.id)).toEqual(['c1', 'c2']);
    expect(controller.getUnreadConversationCount()).toBe(1);
  });

  it('asks for a fresh user token when the session expires', async () => {
    let issued = 0;
    const getUserToken = vi.fn(async () => `alice.token-${++issued}`);
    await controller.loginUser({getUserToken});
    const firstSession = api.calls.find(call => call.path === '/v1/messenger/conversations')!.auth!;

    api.expireSession(firstSession);
    await controller.refreshConversations();

    const boots = api.calls.filter(call => call.path === '/v1/messenger/boot');
    expect(boots.map(call => call.body?.userToken)).toEqual(['alice.token-1', 'alice.token-2']);
    expect(api.calls.at(-1)).toMatchObject({path: '/v1/messenger/conversations'});
    expect(api.calls.at(-1)?.auth).not.toBe(firstSession);
  });

  it('fails the login, rather than falling back to anonymous, when the token is refused', async () => {
    await expect(controller.loginUser({getUserToken: async () => 'expired'})).rejects.toThrow('invalid or has expired');
    expect(controller.getState()).toMatchObject({session: 'verified', status: 'failed'});
  });

  it('counts an agent reply as unread while the messenger is closed and tells the listener', async () => {
    api.conversationsBySubject.set('user:alice', [summary('c1')]);
    await controller.loginUser({getUserToken: async () => 'alice.token'});
    await flush();
    expect(stream.connections).toBe(1);
    const counts: number[] = [];
    controller.addUnreadCountListener(count => counts.push(count));

    stream.emit({type: 'message', conversationId: 'c1', message: agentMessage('m1')});
    await flush();

    expect(counts).toEqual([1]);
    expect(controller.getState().conversations[0]).toMatchObject({id: 'c1', unread: true, lastMessage: {body: 'Hello!'}});
  });

  it('does not count a reply in the conversation the user is looking at', async () => {
    api.conversationsBySubject.set('user:alice', [summary('c1')]);
    await controller.loginUser({getUserToken: async () => 'alice.token'});
    await flush();
    controller.presentConversation('c1');

    stream.emit({type: 'message', conversationId: 'c1', message: agentMessage('m1')});
    await flush();

    expect(controller.getUnreadConversationCount()).toBe(0);
  });

  it("refetches the list when a reply arrives in a conversation it doesn't know yet", async () => {
    await controller.loginUser({getUserToken: async () => 'alice.token'});
    await flush();
    api.conversationsBySubject.set('user:alice', [summary('c9', true)]);

    stream.emit({type: 'message', conversationId: 'c9', message: agentMessage('m1')});
    await flush();

    expect(controller.getUnreadConversationCount()).toBe(1);
  });

  it('logs out by closing the stream and forgetting the visitor, so the next user sees nothing of the last', async () => {
    api.conversationsBySubject.set('user:alice', [summary('c1', true)]);
    await controller.loginUser({getUserToken: async () => 'alice.token'});
    await flush();
    const aliceVisitor = api.calls.find(call => call.path === '/v1/messenger/boot')!.body!.visitorId;

    await controller.logout();
    await flush();

    expect(stream.connections).toBe(0);
    expect(controller.getState()).toMatchObject({session: 'none', status: 'idle', conversations: []});
    expect(controller.getUnreadConversationCount()).toBe(0);
    expect([...storage.values.values()][0]).not.toBe(aliceVisitor);

    await controller.loginUser({getUserToken: async () => 'bob.token'});
    const bobBoot = api.calls.filter(call => call.path === '/v1/messenger/boot').at(-1)!;
    expect(bobBoot.body).toMatchObject({userToken: 'bob.token'});
    expect(bobBoot.body?.visitorId).not.toBe(aliceVisitor);
    expect(controller.getState().conversations).toEqual([]);
  });

  it('keeps the visitor id across launches when storage is given', async () => {
    await controller.loginUnidentifiedUser();
    const first = api.calls.find(call => call.path === '/v1/messenger/boot')!.body!.visitorId;

    const relaunched = new MessengerController({apiUrl: API, publicKey: KEY, storage}, stream.transport);
    await relaunched.loginUnidentifiedUser();
    const second = api.calls.filter(call => call.path === '/v1/messenger/boot').at(-1)!.body!.visitorId;

    expect(second).toBe(first);
    await relaunched.logout();
  });

  it('starts an anonymous session when the messenger is opened before anyone logs in', async () => {
    controller.present();
    await flush();

    expect(controller.getState()).toMatchObject({session: 'anonymous', status: 'ready', visible: true});
    expect(api.calls[0]?.body?.userToken).toBeUndefined();
  });

  it('drops the stream in the background and catches up on returning', async () => {
    await controller.loginUser({getUserToken: async () => 'alice.token'});
    await flush();

    controller.setAppActive(false);
    await flush();
    expect(stream.connections).toBe(0);

    api.conversationsBySubject.set('user:alice', [summary('c1', true)]);
    controller.setAppActive(true);
    await flush();

    expect(stream.connections).toBe(1);
    expect(controller.getUnreadConversationCount()).toBe(1);
  });

  describe('user attributes and events', () => {
    const writes = () => api.calls.filter(call => call.path === '/v1/messenger/user' || call.path === '/v1/messenger/events');

    it('sends them for the signed-in user', async () => {
      await controller.loginUser({getUserToken: async () => 'alice.token'});

      expect(await controller.updateUser({is_premium: true, completed_modules_count: 3})).toBe(true);
      expect(await controller.logEvent('finished_journey_module', {module_id: 'm-4'}, {occurredAt: Date.UTC(2026, 9, 15, 9)})).toBe(true);

      expect(writes()).toMatchObject([
        {path: '/v1/messenger/user', body: {attributes: {is_premium: true, completed_modules_count: 3}}},
        {
          path: '/v1/messenger/events',
          body: {name: 'finished_journey_module', data: {module_id: 'm-4'}, occurredAt: '2026-10-15T09:00:00.000Z'},
        },
      ]);
    });

    it('resolves false without sending anything for an anonymous or signed-out user, so nothing waits for whoever signs in next', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await controller.logEvent('signed_up')).toBe(false);
      await controller.loginUnidentifiedUser();
      expect(await controller.updateUser({is_premium: true})).toBe(false);

      await controller.loginUser({getUserToken: async () => 'alice.token'});
      await flush();
      expect(writes()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs a signed-in user'));
    });

    it('waits for a sign-in that is still booting', async () => {
      const login = controller.loginUser({getUserToken: async () => 'alice.token'});
      const logged = controller.logEvent('signed_up');

      await login;
      expect(await logged).toBe(true);
      expect(writes()).toMatchObject([{path: '/v1/messenger/events', body: {name: 'signed_up'}}]);
    });

    it('resolves false with the reason when the API refuses, instead of rejecting', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await controller.loginUser({getUserToken: async () => 'alice.token'});

      expect(await controller.updateUser({favourite_colour: 'teal'})).toBe(false);
      expect(await controller.logEvent('signed_up', undefined, {occurredAt: 'yesterday'})).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('favourite_colour'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a date'));
    });
  });

  describe('push notifications', () => {
    const TOKEN = 'ExponentPushToken[device-1234]';
    const pushCalls = () => api.calls.filter(call => call.path.startsWith('/v1/messenger/push-token'));

    it('registers the device for each signed-in user, never for an anonymous session, and removes it on logout', async () => {
      controller.registerPushToken(TOKEN);
      await controller.loginUnidentifiedUser();
      await flush();
      expect(pushCalls()).toEqual([]);

      await controller.loginUser({getUserToken: async () => 'alice.token'});
      await flush();
      expect(pushCalls()).toMatchObject([{path: '/v1/messenger/push-token', body: {token: TOKEN}}]);

      await controller.logout();
      await flush();
      expect(pushCalls().at(-1)).toMatchObject({path: '/v1/messenger/push-token/remove', body: {token: TOKEN}});
    });

    it('sends a token that arrives while a user is already signed in', async () => {
      await controller.loginUser({getUserToken: async () => 'alice.token'});
      controller.registerPushToken(TOKEN);
      await flush();

      expect(pushCalls()).toMatchObject([{path: '/v1/messenger/push-token', body: {token: TOKEN}}]);
    });

    it('opens a tapped conversation once the user has signed in, as on a cold start', async () => {
      expect(controller.handlePushNotification({plunk: {conversationId: 'c9'}})).toBe(true);
      expect(controller.getState().visible).toBe(false);

      await controller.loginUser({getUserToken: async () => 'alice.token'});

      expect(controller.getState()).toMatchObject({visible: true, route: {screen: 'thread', conversationId: 'c9'}});
    });

    it('opens a tapped conversation straight away while signed in, and ignores other notifications', async () => {
      await controller.loginUser({getUserToken: async () => 'alice.token'});

      expect(controller.handlePushNotification({screen: 'meditations'})).toBe(false);
      expect(controller.getState().visible).toBe(false);
      expect(controller.handlePushNotification({plunk: {conversationId: 'c1'}})).toBe(true);
      expect(controller.getState()).toMatchObject({visible: true, route: {screen: 'thread', conversationId: 'c1'}});
    });

    it('forgets a pending tap on logout', async () => {
      controller.handlePushNotification({plunk: {conversationId: 'c9'}});
      await controller.logout();
      await controller.loginUser({getUserToken: async () => 'bob.token'});

      expect(controller.getState().visible).toBe(false);
    });
  });
});
