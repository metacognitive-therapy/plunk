import {Role} from '@plunk/db';
import request from 'supertest';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {Keys} from '../../services/keys';
import {MembershipService} from '../../services/MembershipService';
import {QueueService} from '../../services/QueueService';
import {RealtimeHub} from '../../services/RealtimeHub';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

async function inbox() {
  const {owner, project} = await messengerProject();
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  return {owner, project, visitorToken: started.token, conversationId: started.conversation.id};
}

async function addMember(projectId: string, supportAgent: boolean, name = 'Kari Nordmann') {
  const created = await factories.createUser();
  const user = await prisma.user.update({where: {id: created.id}, data: {name, emailVerified: true}});
  await prisma.membership.create({data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent}});
  return user;
}

function addNote(
  agent: {id: string},
  projectId: string,
  conversationId: string,
  body: string,
  mentionedUserIds: string[] = [],
) {
  return request(app)
    .post(`/conversations/${conversationId}/notes`)
    .set(asAgent(agent.id, projectId))
    .send({body, mentionedUserIds});
}

function stubQueue() {
  return vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Live chat notes and mentions', () => {
  it('adds a note to the agent thread and never shows it to the visitor', async () => {
    stubQueue();
    const {owner, project, conversationId, visitorToken} = await inbox();
    const publish = vi.spyOn(RealtimeHub, 'publish');

    const res = await addNote(owner, project.id, conversationId, 'Customer is on the old plan');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({kind: 'NOTE', authorType: 'AGENT', body: 'Customer is on the old plan'});

    const thread = await request(app).get(`/conversations/${conversationId}`).set(asAgent(owner.id, project.id));
    expect(thread.body.data.messages.map((m: {kind: string; body: string}) => [m.kind, m.body])).toContainEqual([
      'NOTE',
      'Customer is on the old plan',
    ]);

    const visitorEvents = publish.mock.calls.filter(([channel]) => channel.includes(':visitor:'));
    expect(visitorEvents).toEqual([]);
    const inboxEvents = publish.mock.calls.filter(([channel]) => channel === Keys.Realtime.project(project.id));
    expect(inboxEvents.map(([, event]) => (event as {type: string}).type)).toContain('message');

    const visitorThread = await request(app)
      .get(`/v1/messenger/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(JSON.stringify(visitorThread.body)).not.toContain('old plan');
    const visitorList = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${visitorToken}`);
    expect(JSON.stringify(visitorList.body)).not.toContain('old plan');
  });

  it('is not a response and changes neither the status nor the place in the list', async () => {
    stubQueue();
    const {owner, project, conversationId} = await inbox();
    await request(app)
      .post(`/conversations/${conversationId}/status`)
      .set(asAgent(owner.id, project.id))
      .send({status: 'CLOSED'});
    const before = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});

    expect((await addNote(owner, project.id, conversationId, 'Following up internally')).status).toBe(201);

    const after = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    expect(after.status).toBe('CLOSED');
    expect(after.firstResponseAt).toBeNull();
    expect(after.lastMessageAt).toEqual(before.lastMessageAt);
    expect(after.lastMessagePreview).toBe(before.lastMessagePreview);
    expect(after.lastMessageAuthorType).toBe('CONTACT');
  });

  it('records mentions of support agents and queues their notification', async () => {
    const queue = stubQueue();
    const {owner, project, conversationId} = await inbox();
    const kari = await addMember(project.id, true);

    const res = await addNote(owner, project.id, conversationId, '@Kari Nordmann can you take this?', [kari.id, kari.id]);
    expect(res.status).toBe(201);
    expect(res.body.data.mentions).toEqual([{id: kari.id, name: 'Kari Nordmann'}]);

    const stored = await prisma.conversationMessage.findUniqueOrThrow({where: {id: res.body.data.id}});
    expect(stored.mentionedUserIds).toEqual([kari.id]);
    expect(queue).toHaveBeenCalledWith({type: 'mention', messageId: stored.id});
  });

  it('does not queue a notification when the only mention is the author', async () => {
    const queue = stubQueue();
    const {owner, project, conversationId} = await inbox();

    expect((await addNote(owner, project.id, conversationId, 'Note to self', [owner.id])).status).toBe(201);
    expect(queue).not.toHaveBeenCalledWith(expect.objectContaining({type: 'mention'}));
  });

  it('refuses to mention anyone who is not a support agent of the project', async () => {
    const queue = stubQueue();
    const {owner, project, conversationId} = await inbox();
    const member = await addMember(project.id, false, 'Not An Agent');
    const {user: outsider} = await factories.createUserWithProject();

    for (const id of [member.id, outsider.id]) {
      const res = await addNote(owner, project.id, conversationId, 'Hello', [id]);
      expect(res.status).toBe(400);
    }
    expect(await prisma.conversationMessage.count({where: {conversationId, kind: 'NOTE', authorType: 'AGENT'}})).toBe(0);
    expect(queue).not.toHaveBeenCalledWith(expect.objectContaining({type: 'mention'}));
  });

  it('only lets support agents write notes', async () => {
    const {project, conversationId} = await inbox();
    const member = await addMember(project.id, false);

    expect((await addNote(member, project.id, conversationId, 'Hi')).status).toBe(403);
  });

  describe('mention delivery', () => {
    it('notifies the mentioned agents only, on their personal channel', async () => {
      stubQueue();
      const {owner, project, conversationId} = await inbox();
      const kari = await addMember(project.id, true);
      const ola = await addMember(project.id, true, 'Ola Hansen');
      const note = await addNote(owner, project.id, conversationId, '@Kari Nordmann please check the invoice', [
        kari.id,
        owner.id,
      ]);
      const publish = vi.spyOn(RealtimeHub, 'publish');

      expect(await ChatNotificationService.process({type: 'mention', messageId: note.body.data.id})).toEqual({
        notified: 1,
      });

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(Keys.Realtime.user(kari.id), {
        type: 'mention',
        projectId: project.id,
        conversationId,
        messageId: note.body.data.id,
        author: {id: owner.id, name: expect.any(String)},
        preview: '@Kari Nordmann please check the invoice',
      });
      expect(publish.mock.calls.some(([channel]) => channel === Keys.Realtime.user(ola.id))).toBe(false);
    });

    it('skips anyone who stopped being a support agent before delivery', async () => {
      stubQueue();
      const {owner, project, conversationId} = await inbox();
      const kari = await addMember(project.id, true);
      const note = await addNote(owner, project.id, conversationId, 'Over to you', [kari.id]);
      await MembershipService.setSupportAgent(project.id, kari.id, false);
      const publish = vi.spyOn(RealtimeHub, 'publish');

      expect(await ChatNotificationService.process({type: 'mention', messageId: note.body.data.id})).toEqual({
        notified: 0,
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('ignores a message that no longer exists', async () => {
      expect(
        await ChatNotificationService.process({type: 'mention', messageId: '00000000-0000-0000-0000-000000000000'}),
      ).toEqual({notified: 0});
    });
  });
});
