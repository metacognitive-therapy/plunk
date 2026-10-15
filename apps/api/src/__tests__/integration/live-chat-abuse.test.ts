import {randomUUID} from 'node:crypto';

import request from 'supertest';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {Messenger} from '../../controllers/Messenger';
import {redis} from '../../database/redis';
import {messengerRateLimits} from '../../middleware/messengerRateLimit';
import {Keys} from '../../services/keys';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const turnstile = vi.hoisted(() => ({enabled: false}));
vi.mock('../../app/constants', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/constants')>();
  return {
    ...actual,
    get TURNSTILE_ENABLED() {
      return turnstile.enabled;
    },
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  };
});

const app = buildHttpApp({controllers: [new Messenger()]});
app.set('trust proxy', 1);
const {session} = messengerClient(app);

/* Each test gets its own address so the IP budgets of one never spill into the next. */
let ip: string;
beforeEach(() => {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  ip = `10.${octet()}.${octet()}.${octet()}`;
});

function from<T extends request.Test>(req: T): T {
  return req.set('X-Forwarded-For', ip) as T;
}

/* The token bucket reads the clock from Redis, so moving its last-seen time back is how a test
lets a window pass without waiting for it. */
async function rewind(key: string, seconds: number) {
  const ts = Number(await redis.hget(key, 'ts'));
  expect(ts).toBeGreaterThan(0);
  await redis.hset(key, 'ts', String(ts - seconds));
}

function start(token: string, body: Record<string, unknown> = {body: 'Hello'}) {
  return from(request(app).post('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`)).send(body);
}

function send(token: string, conversationId: string, body = 'Another message') {
  return from(
    request(app).post(`/v1/messenger/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${token}`),
  ).send({body});
}

async function visitorSession(publicKey: string, visitor = visitorId()) {
  const res = await from(request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${publicKey}`))
    .set('Origin', API_ORIGIN)
    .send({visitorId: visitor, parentOrigin: ALLOWED});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {token: res.body.data.token as string, visitor};
}

describe('Messenger rate limits', () => {
  beforeAll(() => {
    messengerRateLimits.enabled = true;
  });
  afterAll(() => {
    messengerRateLimits.enabled = false;
  });

  it('refuses a visitor who starts too many conversations, then lets them continue', async () => {
    const {project} = await messengerProject();
    const {token: bootToken, visitor} = await visitorSession(project.public);
    let token = bootToken;

    for (let i = 0; i < 5; i++) {
      const res = await start(token);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      token = res.body.data.token;
    }
    const refused = await start(token);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    await rewind(Keys.RateLimit.messenger('start', 'visitor', `${project.id}:${visitor}`), 120);
    expect((await start(token)).status).toBe(201);
  });

  it('refuses a burst of messages, then accepts the next one after the window', async () => {
    const {project} = await messengerProject();
    const {token: bootToken} = await visitorSession(project.public);
    const started = await start(bootToken);
    const token = started.body.data.token as string;
    const conversationId = started.body.data.conversation.id as string;

    for (let i = 0; i < 30; i++) {
      expect((await send(token, conversationId)).status).toBe(201);
    }
    expect((await send(token, conversationId)).status).toBe(429);

    await new Promise(resolve => setTimeout(resolve, 2100));
    expect((await send(token, conversationId, 'Sorry, one more')).status).toBe(201);
  });

  it('limits uploads and email capture', async () => {
    const {project} = await messengerProject();
    const {token: bootToken} = await visitorSession(project.public);
    const started = await start(bootToken);
    let token = started.body.data.token as string;
    const conversationId = started.body.data.conversation.id as string;

    /* No file attached: the limiter runs before the upload is read, so a 400 still spends a token. */
    for (let i = 0; i < 10; i++) {
      const res = await from(
        request(app).post(`/v1/messenger/conversations/${conversationId}/attachments`).set('Authorization', `Bearer ${token}`),
      );
      expect(res.status).toBe(400);
    }
    const uploadRefused = await from(
      request(app).post(`/v1/messenger/conversations/${conversationId}/attachments`).set('Authorization', `Bearer ${token}`),
    );
    expect(uploadRefused.status).toBe(429);

    const capture = (email: string) =>
      from(request(app).post('/v1/messenger/email').set('Authorization', `Bearer ${token}`)).send({
        conversationId,
        email,
        subscribe: false,
      });
    const first = await capture(`visitor-${randomUUID()}@example.com`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    token = first.body.data.token;
    for (let i = 0; i < 4; i++) {
      expect((await capture(`visitor-${randomUUID()}@example.com`)).status).toBe(409);
    }
    expect((await capture(`visitor-${randomUUID()}@example.com`)).status).toBe(429);
  });

  it('limits boots per visitor', async () => {
    const {project} = await messengerProject();
    const visitor = visitorId();
    for (let i = 0; i < 30; i++) {
      await visitorSession(project.public, visitor);
    }
    const refused = await from(request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${project.public}`))
      .set('Origin', API_ORIGIN)
      .send({visitorId: visitor, parentOrigin: ALLOWED});
    expect(refused.status).toBe(429);

    expect((await visitorSession(project.public)).token).toBeTruthy();
  });

  it('limits many visitors behind one address', async () => {
    const {project} = await messengerProject();
    for (let v = 0; v < 4; v++) {
      let {token} = await visitorSession(project.public);
      for (let i = 0; i < 5; i++) {
        const res = await start(token);
        expect(res.status).toBe(201);
        token = res.body.data.token;
      }
    }
    const {token} = await visitorSession(project.public);
    expect((await start(token)).status).toBe(429);
  });
});

describe('Turnstile bot check', () => {
  const realFetch = globalThis.fetch;
  let verifications: URLSearchParams[] = [];

  beforeEach(() => {
    turnstile.enabled = true;
    verifications = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith('https://challenges.cloudflare.com/')) {
        return realFetch(input, init);
      }
      const params = init?.body as URLSearchParams;
      verifications.push(params);
      return new Response(JSON.stringify({success: params.get('response') === 'human'}), {
        headers: {'Content-Type': 'application/json'},
      });
    });
  });
  afterEach(() => {
    turnstile.enabled = false;
    vi.restoreAllMocks();
  });

  it('tells the messenger which site key to render', async () => {
    const {project} = await messengerProject();
    const res = await from(request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${project.public}`))
      .set('Origin', API_ORIGIN)
      .send({visitorId: visitorId(), parentOrigin: ALLOWED});
    expect(res.body.data.turnstileSiteKey).toBe('1x00000000000000000000AA');
  });

  it('refuses a new conversation without a valid token', async () => {
    const {project} = await messengerProject();
    const {token} = await session(project.public);

    expect((await start(token)).status).toBe(403);
    expect((await start(token, {body: 'Hello', turnstileToken: 'bot'})).status).toBe(403);
    expect(verifications.at(-1)?.get('secret')).toBe('1x0000000000000000000000000000000AA');
    expect(verifications.at(-1)?.get('remoteip')).toBe(ip);
  });

  it('starts a conversation with a valid token and needs none for later messages', async () => {
    const {project} = await messengerProject();
    const {token: bootToken} = await session(project.public);

    const started = await start(bootToken, {body: 'Hello', turnstileToken: 'human'});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const checks = verifications.length;

    const reply = await send(started.body.data.token, started.body.data.conversation.id);
    expect(reply.status).toBe(201);
    expect(verifications.length).toBe(checks);
  });

  it('refuses when Cloudflare cannot be reached', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network down'));
    const {project} = await messengerProject();
    const {token} = await session(project.public);
    expect((await start(token, {body: 'Hello', turnstileToken: 'human'})).status).toBe(403);
  });

  it('starts conversations without a check when Turnstile is not configured', async () => {
    turnstile.enabled = false;
    const {project} = await messengerProject();
    const {token} = await session(project.public);

    const boot = await from(request(app).post('/v1/messenger/boot').set('Authorization', `Bearer ${project.public}`))
      .set('Origin', API_ORIGIN)
      .send({visitorId: visitorId(), parentOrigin: ALLOWED});
    expect(boot.body.data.turnstileSiteKey).toBeNull();
    expect((await start(token)).status).toBe(201);
    expect(verifications).toEqual([]);
  });
});
