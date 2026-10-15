import {randomUUID} from 'node:crypto';

import {Role} from '@plunk/db';
import type {AgentStreamEvent, ChatPushPayload} from '@plunk/types';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Users} from '../../controllers/Users';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {Keys} from '../../services/keys';
import {QueueService} from '../../services/QueueService';
import {RealtimeHub} from '../../services/RealtimeHub';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const push = vi.hoisted(() => {
  class WebPushError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
    }
  }
  return {enabled: true, sendNotification: vi.fn(), WebPushError};
});

vi.mock('web-push', () => ({
  default: {sendNotification: push.sendNotification, WebPushError: push.WebPushError},
}));

vi.mock('../../app/constants', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/constants')>();
  return {
    ...actual,
    get WEB_PUSH_ENABLED() {
      return push.enabled;
    },
    VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
    VAPID_PRIVATE_KEY: 'private-key-for-tests',
    VAPID_SUBJECT: 'mailto:support@example.com',
  };
});

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new Users()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

async function addMember(projectId: string, supportAgent: boolean) {
  const created = await factories.createUser();
  const user = await prisma.user.update({where: {id: created.id}, data: {emailVerified: true}});
  await prisma.membership.create({data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent}});
  return user;
}

async function subscribe(userId: string) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await prisma.webPushSubscription.create({data: {userId, endpoint, p256dh: 'p256dh-key', auth: 'auth-secret'}});
  return endpoint;
}

/** A support team: the owner, an agent, a member without inbox access, and an agent of another project. */
async function team() {
  const {owner, project} = await messengerProject();
  const agent = await addMember(project.id, true);
  const member = await addMember(project.id, false);
  const other = await messengerProject();
  return {owner, project, agent, member, outsider: other.owner};
}

async function visitorWrites(publicKey: string, body = 'Is the evening group still running?') {
  const visitor = await session(publicKey);
  const started = await startConversation(visitor.token, body);
  return {token: started.token, conversationId: started.conversation.id};
}

async function latestVisitorMessage(conversationId: string) {
  return prisma.conversationMessage.findFirstOrThrow({
    where: {conversationId, authorType: 'CONTACT'},
    orderBy: {createdAt: 'desc'},
  });
}

function userEvents(publish: ReturnType<typeof vi.spyOn>) {
  const events = new Map<string, AgentStreamEvent[]>();
  for (const [channel, event] of publish.mock.calls as [string, AgentStreamEvent][]) {
    if (channel.startsWith('realtime:user:')) {
      const userId = channel.slice('realtime:user:'.length);
      events.set(userId, [...(events.get(userId) ?? []), event]);
    }
  }
  return events;
}

function pushedTo(): {endpoint: string; payload: ChatPushPayload}[] {
  return push.sendNotification.mock.calls.map(([subscription, payload]) => ({
    endpoint: subscription.endpoint,
    payload: JSON.parse(payload as string),
  }));
}

beforeEach(() => {
  push.enabled = true;
  push.sendNotification.mockReset().mockResolvedValue({statusCode: 201});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Notifying agents of visitor messages', () => {
  it('queues a notification for every visitor message and none for agent replies', async () => {
    const queue = vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project} = await messengerProject();
    const {token, conversationId} = await visitorWrites(project.public);

    const second = await request(app)
      .post(`/v1/messenger/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({body: 'And is there parking?'});
    expect(second.status).toBe(201);
    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Yes, behind the building.'})
      .expect(201);

    const jobs = queue.mock.calls.map(([data]) => data);
    expect(jobs.filter(job => job.type === 'visitor_message')).toHaveLength(2);
    expect(jobs.filter(job => job.type === 'visitor_message').map(job => job.messageId)).toContain(second.body.data.id);
  });

  it('alerts every support agent while unassigned, and nobody outside the project', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project, agent, member, outsider} = await team();
    const endpoints = {
      owner: await subscribe(owner.id),
      agent: await subscribe(agent.id),
      member: await subscribe(member.id),
      outsider: await subscribe(outsider.id),
    };
    const {conversationId} = await visitorWrites(project.public, 'Can I move my session to Thursday?');
    const message = await latestVisitorMessage(conversationId);

    const publish = vi.spyOn(RealtimeHub, 'publish');
    expect(await ChatNotificationService.process({type: 'visitor_message', messageId: message.id})).toEqual({
      notified: 2,
    });

    const events = userEvents(publish);
    expect([...events.keys()].sort()).toEqual([owner.id, agent.id].sort());
    expect(events.get(agent.id)).toEqual([
      {type: 'visitor_message', projectId: project.id, conversationId, alert: true},
    ]);

    const pushes = pushedTo();
    expect(pushes.map(p => p.endpoint).sort()).toEqual([endpoints.owner, endpoints.agent].sort());
    expect(pushes[0]!.payload).toEqual({
      title: expect.stringContaining('·'),
      body: 'Can I move my session to Thursday?',
      url: `/inbox?project=${project.id}&view=all&c=${conversationId}`,
      tag: `conversation-${conversationId}`,
    });
  });

  it('alerts only the assignee once assigned, while every agent’s badge still updates', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project, agent} = await team();
    const ownerEndpoint = await subscribe(owner.id);
    const agentEndpoint = await subscribe(agent.id);
    const {token, conversationId} = await visitorWrites(project.public);
    await request(app)
      .post(`/conversations/${conversationId}/assignee`)
      .set(asAgent(owner.id, project.id))
      .send({assigneeId: agent.id})
      .expect(200);
    await request(app)
      .post(`/v1/messenger/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({body: 'Hello again'})
      .expect(201);

    const publish = vi.spyOn(RealtimeHub, 'publish');
    await ChatNotificationService.process({
      type: 'visitor_message',
      messageId: (await latestVisitorMessage(conversationId)).id,
    });

    const events = userEvents(publish);
    expect(events.get(agent.id)?.[0]).toMatchObject({alert: true});
    expect(events.get(owner.id)?.[0]).toMatchObject({alert: false});
    expect(pushedTo().map(p => p.endpoint)).toEqual([agentEndpoint]);
    expect(pushedTo().map(p => p.endpoint)).not.toContain(ownerEndpoint);
  });

  it('keeps message text and the visitor’s name off the lock screen when the agent asks', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project} = await messengerProject();
    await prisma.user.update({where: {id: owner.id}, data: {pushPreview: false}});
    await subscribe(owner.id);
    const {conversationId} = await visitorWrites(project.public, 'I have been feeling anxious lately');

    await ChatNotificationService.process({
      type: 'visitor_message',
      messageId: (await latestVisitorMessage(conversationId)).id,
    });

    const [sent] = pushedTo();
    expect(JSON.stringify(sent!.payload)).not.toContain('anxious');
    expect(sent!.payload.title).toMatch(/^New message · /);
  });

  it('deletes subscriptions the push service reports as gone and keeps the rest', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project} = await messengerProject();
    const gone = await subscribe(owner.id);
    const flaky = await subscribe(owner.id);
    push.sendNotification.mockImplementation(async (subscription: {endpoint: string}) => {
      throw new push.WebPushError('failed', subscription.endpoint === gone ? 410 : 503);
    });
    const {conversationId} = await visitorWrites(project.public);

    await ChatNotificationService.process({
      type: 'visitor_message',
      messageId: (await latestVisitorMessage(conversationId)).id,
    });

    const left = await prisma.webPushSubscription.findMany({where: {userId: owner.id}, select: {endpoint: true}});
    expect(left.map(s => s.endpoint)).toEqual([flaky]);
  });

  it('pushes nothing when push is not configured, but still updates the dashboard', async () => {
    push.enabled = false;
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project} = await messengerProject();
    await subscribe(owner.id);
    const {conversationId} = await visitorWrites(project.public);
    const publish = vi.spyOn(RealtimeHub, 'publish');

    await ChatNotificationService.process({
      type: 'visitor_message',
      messageId: (await latestVisitorMessage(conversationId)).id,
    });

    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(Keys.Realtime.user(owner.id), expect.objectContaining({alert: true}));
  });

  it('pushes a mention to the mentioned agent', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project, agent} = await team();
    const endpoint = await subscribe(agent.id);
    const {conversationId} = await visitorWrites(project.public);
    const note = await request(app)
      .post(`/conversations/${conversationId}/notes`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Can you take this one?', mentionedUserIds: [agent.id]})
      .expect(201);

    await ChatNotificationService.process({type: 'mention', messageId: note.body.data.id});

    expect(pushedTo()).toEqual([
      {
        endpoint,
        payload: expect.objectContaining({body: 'Can you take this one?', tag: `mention-${note.body.data.id}`}),
      },
    ]);
  });
});

describe('Push subscriptions', () => {
  it('saves a browser, moves it to whoever signs in on it, and removes it', async () => {
    const {owner, project} = await messengerProject();
    const {agent} = await team();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const body = {endpoint, keys: {p256dh: 'p256dh-key', auth: 'auth-secret'}};

    await request(app).post('/users/@me/push-subscriptions').set(asAgent(owner.id, project.id)).send(body).expect(204);
    await request(app).post('/users/@me/push-subscriptions').set(asAgent(agent.id, project.id)).send(body).expect(204);
    expect(await prisma.webPushSubscription.findUnique({where: {endpoint}})).toMatchObject({userId: agent.id});

    await request(app)
      .delete('/users/@me/push-subscriptions')
      .set(asAgent(owner.id, project.id))
      .send({endpoint})
      .expect(204);
    expect(await prisma.webPushSubscription.findUnique({where: {endpoint}})).not.toBeNull();
    await request(app)
      .delete('/users/@me/push-subscriptions')
      .set(asAgent(agent.id, project.id))
      .send({endpoint})
      .expect(204);
    expect(await prisma.webPushSubscription.findUnique({where: {endpoint}})).toBeNull();
  });

  it('only accepts the browsers’ own push services', async () => {
    const {owner, project} = await messengerProject();
    for (const endpoint of ['https://169.254.169.254/latest', 'https://evil.example.com/push', 'http://fcm.googleapis.com/x']) {
      const res = await request(app)
        .post('/users/@me/push-subscriptions')
        .set(asAgent(owner.id, project.id))
        .send({endpoint, keys: {p256dh: 'a', auth: 'b'}});
      expect(res.status, endpoint).toBeGreaterThanOrEqual(400);
    }
    expect(await prisma.webPushSubscription.count({where: {userId: owner.id}})).toBe(0);
  });

  it('refuses to subscribe when push is not configured', async () => {
    push.enabled = false;
    const {owner, project} = await messengerProject();
    const res = await request(app)
      .post('/users/@me/push-subscriptions')
      .set(asAgent(owner.id, project.id))
      .send({endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: {p256dh: 'a', auth: 'b'}});
    expect(res.status).toBe(404);
  });
});

describe('Agent notification settings', () => {
  it('reads and updates the agent’s own toggles', async () => {
    const {owner, project} = await messengerProject();
    const read = await request(app).get('/users/@me/notifications').set(asAgent(owner.id, project.id)).expect(200);
    expect(read.body.data).toEqual({inboxBadge: true, inboxTitleCount: true, inboxSound: true, pushPreview: true});

    const updated = await request(app)
      .patch('/users/@me/notifications')
      .set(asAgent(owner.id, project.id))
      .send({inboxSound: false, pushPreview: false})
      .expect(200);
    expect(updated.body.data).toEqual({inboxBadge: true, inboxTitleCount: true, inboxSound: false, pushPreview: false});

    await request(app)
      .patch('/users/@me/notifications')
      .set(asAgent(owner.id, project.id))
      .send({inboxSound: 'loud'})
      .expect(422);
  });
});

describe('Unread badge', () => {
  it('counts the agent’s unread conversations across projects', async () => {
    vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
    const {owner, project, agent} = await team();
    const second = await messengerProject();
    await prisma.membership.create({
      data: {userId: agent.id, projectId: second.project.id, role: Role.MEMBER, supportAgent: true},
    });
    const unread = () =>
      request(app)
        .get('/users/@me/inbox-unread')
        .set(asAgent(agent.id, project.id))
        .expect(200)
        .then(res => res.body.data);

    const first = await visitorWrites(project.public);
    const read = await visitorWrites(project.public);
    const theirs = await visitorWrites(project.public);
    const closed = await visitorWrites(project.public);
    await visitorWrites(second.project.public);

    await request(app).post(`/conversations/${read.conversationId}/read`).set(asAgent(agent.id, project.id));
    await request(app)
      .post(`/conversations/${theirs.conversationId}/assignee`)
      .set(asAgent(owner.id, project.id))
      .send({assigneeId: owner.id})
      .expect(200);
    await request(app)
      .post(`/conversations/${closed.conversationId}/status`)
      .set(asAgent(owner.id, project.id))
      .send({status: 'CLOSED'})
      .expect(200);

    expect(await unread()).toEqual({total: 2, cap: 1000, projects: {[project.id]: 1, [second.project.id]: 1}});

    await request(app)
      .post(`/conversations/${first.conversationId}/assignee`)
      .set(asAgent(owner.id, project.id))
      .send({assigneeId: agent.id})
      .expect(200);
    await request(app)
      .post(`/v1/messenger/conversations/${read.conversationId}/messages`)
      .set('Authorization', `Bearer ${read.token}`)
      .send({body: 'One more thing'})
      .expect(201);

    expect((await unread()).projects[project.id]).toBe(2);
  });

  it('is empty for someone who supports no project', async () => {
    const {project} = await messengerProject();
    const member = await addMember(project.id, false);
    const res = await request(app).get('/users/@me/inbox-unread').set(asAgent(member.id, project.id)).expect(200);
    expect(res.body.data).toEqual({total: 0, cap: 1000, projects: {}});
  });
});
