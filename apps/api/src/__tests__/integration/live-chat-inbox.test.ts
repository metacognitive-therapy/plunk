import {randomUUID} from 'node:crypto';

import {Role} from '@plunk/db';
import request from 'supertest';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {ConversationService, INBOX_COUNT_CAP} from '../../services/ConversationService';
import {MembershipService} from '../../services/MembershipService';
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
  const user = await prisma.user.update({where: {id: created.id}, data: {name}});
  await prisma.membership.create({data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent}});
  return user;
}

function setStatus(agent: {id: string}, projectId: string, conversationId: string, body: object) {
  return request(app).post(`/conversations/${conversationId}/status`).set(asAgent(agent.id, projectId)).send(body);
}

function assign(agent: {id: string}, projectId: string, conversationId: string, assigneeId: string | null) {
  return request(app)
    .post(`/conversations/${conversationId}/assignee`)
    .set(asAgent(agent.id, projectId))
    .send({assigneeId});
}

function systemLines(conversationId: string) {
  return prisma.conversationMessage.findMany({
    where: {conversationId, authorType: 'SYSTEM'},
    orderBy: {createdAt: 'asc'},
  });
}

function sendAsVisitor(token: string, conversationId: string, body = 'Any news?') {
  return request(app)
    .post(`/v1/messenger/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send({body});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Live chat inbox workflow', () => {
  describe('status changes', () => {
    it('closes and reopens, recording each change as a system line by the agent', async () => {
      const {owner, project, conversationId} = await inbox();

      const closed = await setStatus(owner, project.id, conversationId, {status: 'CLOSED'});
      expect(closed.status).toBe(200);
      expect(closed.body.data.status).toBe('CLOSED');
      const afterClose = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
      expect(afterClose.closedAt).toBeInstanceOf(Date);

      const reopened = await setStatus(owner, project.id, conversationId, {status: 'OPEN'});
      expect(reopened.body.data.status).toBe('OPEN');
      expect((await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}})).closedAt).toBeNull();

      const lines = await systemLines(conversationId);
      expect(lines.map(line => line.meta)).toEqual([{action: 'closed'}, {action: 'reopened', trigger: 'agent'}]);
      expect(lines.every(line => line.authorUserId === owner.id && line.kind === 'NOTE')).toBe(true);

      const thread = reopened.body.data.messages.filter((m: {authorType: string}) => m.authorType === 'SYSTEM');
      expect(thread.map((m: {event: unknown}) => m.event)).toEqual([
        {action: 'closed'},
        {action: 'reopened', trigger: 'agent'},
      ]);
      expect(thread[0].author.id).toBe(owner.id);
    });

    it('snoozes until a date and until the visitor replies', async () => {
      const {owner, project, conversationId} = await inbox();
      const until = new Date(Date.now() + 60 * 60_000);

      const dated = await setStatus(owner, project.id, conversationId, {status: 'SNOOZED', snoozedUntil: until.toISOString()});
      expect(dated.status).toBe(200);
      expect(dated.body.data).toMatchObject({status: 'SNOOZED', snoozedUntil: until.toISOString()});

      const untilReply = await setStatus(owner, project.id, conversationId, {status: 'SNOOZED', snoozedUntil: null});
      expect(untilReply.body.data).toMatchObject({status: 'SNOOZED', snoozedUntil: null});

      expect((await systemLines(conversationId)).map(line => line.meta)).toEqual([
        {action: 'snoozed', until: until.toISOString()},
        {action: 'snoozed', until: null},
      ]);
    });

    it('refuses a snooze date that is not in the future', async () => {
      const {owner, project, conversationId} = await inbox();
      const res = await setStatus(owner, project.id, conversationId, {
        status: 'SNOOZED',
        snoozedUntil: new Date(Date.now() - 1000).toISOString(),
      });
      expect(res.status).toBe(400);
      expect(await systemLines(conversationId)).toHaveLength(0);
    });

    it('records nothing for a change that changes nothing', async () => {
      const {owner, project, conversationId} = await inbox();
      await setStatus(owner, project.id, conversationId, {status: 'OPEN'});
      await setStatus(owner, project.id, conversationId, {status: 'CLOSED'});
      await setStatus(owner, project.id, conversationId, {status: 'CLOSED'});
      expect(await systemLines(conversationId)).toHaveLength(1);
    });

    it('records a single line when two agents close at the same time', async () => {
      const {owner, project, conversationId} = await inbox();
      const agent = await addMember(project.id, true);

      const results = await Promise.all([
        setStatus(owner, project.id, conversationId, {status: 'CLOSED'}),
        setStatus(agent, project.id, conversationId, {status: 'CLOSED'}),
      ]);

      expect(results.map(res => res.status)).toEqual([200, 200]);
      expect(await systemLines(conversationId)).toHaveLength(1);
    });

    it('does not move the conversation in the list or touch the visitor-facing preview', async () => {
      const {owner, project, conversationId} = await inbox();
      const before = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});

      await setStatus(owner, project.id, conversationId, {status: 'CLOSED'});

      const after = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
      expect(after.lastMessageAt).toEqual(before.lastMessageAt);
      expect(after.lastMessagePreview).toBe(before.lastMessagePreview);
      expect(after.lastMessageAuthorType).toBe('CONTACT');
    });

    it('never shows system lines to the visitor', async () => {
      const {owner, project, conversationId, visitorToken} = await inbox();
      const publish = vi.spyOn(RealtimeHub, 'publish');

      await setStatus(owner, project.id, conversationId, {status: 'CLOSED'});
      await assign(owner, project.id, conversationId, owner.id);

      const visitorEvents = publish.mock.calls.filter(([channel]) => channel.includes(':visitor:'));
      expect(visitorEvents.map(([, event]) => event)).toEqual([{type: 'conversation', conversationId, status: 'CLOSED'}]);

      const thread = await request(app)
        .get(`/v1/messenger/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${visitorToken}`);
      expect(thread.status).toBe(200);
      expect(thread.body.data.messages.map((m: {authorType: string}) => m.authorType)).toEqual(['CONTACT']);

      const list = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${visitorToken}`);
      expect(list.body.data[0].lastMessage.authorType).toBe('CONTACT');
    });
  });

  describe('visitor replies', () => {
    it.each([
      ['closed', {status: 'CLOSED'}],
      ['snoozed until a date', {status: 'SNOOZED', snoozedUntil: new Date(Date.now() + 86_400_000).toISOString()}],
      ['snoozed until a reply', {status: 'SNOOZED', snoozedUntil: null}],
    ])('reopen a conversation that is %s', async (_label, change) => {
      const {owner, project, conversationId, visitorToken} = await inbox();
      await setStatus(owner, project.id, conversationId, change);

      const res = await sendAsVisitor(visitorToken, conversationId);
      expect(res.status).toBe(201);

      const stored = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
      expect(stored).toMatchObject({status: 'OPEN', closedAt: null, snoozedUntil: null});

      const thread = await prisma.conversationMessage.findMany({
        where: {conversationId},
        orderBy: {createdAt: 'asc'},
      });
      const last = thread.slice(-2);
      expect(last[0]).toMatchObject({authorType: 'SYSTEM', authorUserId: null, meta: {action: 'reopened', trigger: 'contact'}});
      expect(last[1]).toMatchObject({authorType: 'CONTACT', body: 'Any news?'});
    });

    it('add no line when the conversation is already open', async () => {
      const {conversationId, visitorToken} = await inbox();
      await sendAsVisitor(visitorToken, conversationId);
      expect(await systemLines(conversationId)).toHaveLength(0);
    });
  });

  describe('snooze sweep', () => {
    it('reopens conversations whose snooze date has passed and leaves the rest', async () => {
      const due = await inbox();
      const later = await inbox();
      const untilReply = await inbox();
      const soon = new Date(Date.now() + 60_000);
      await setStatus(due.owner, due.project.id, due.conversationId, {status: 'SNOOZED', snoozedUntil: soon.toISOString()});
      await setStatus(later.owner, later.project.id, later.conversationId, {
        status: 'SNOOZED',
        snoozedUntil: new Date(Date.now() + 3 * 60_000).toISOString(),
      });
      await setStatus(untilReply.owner, untilReply.project.id, untilReply.conversationId, {
        status: 'SNOOZED',
        snoozedUntil: null,
      });

      const woken = await ConversationService.wakeSnoozed(new Date(soon.getTime() + 1));

      expect(woken).toBeGreaterThanOrEqual(1);
      const status = async (id: string) => (await prisma.conversation.findUniqueOrThrow({where: {id}})).status;
      expect(await status(due.conversationId)).toBe('OPEN');
      expect(await status(later.conversationId)).toBe('SNOOZED');
      expect(await status(untilReply.conversationId)).toBe('SNOOZED');

      const lines = await systemLines(due.conversationId);
      expect(lines.at(-1)).toMatchObject({authorUserId: null, meta: {action: 'reopened', trigger: 'snooze_expired'}});

      const list = await request(app)
        .get('/conversations?view=unassigned')
        .set(asAgent(due.owner.id, due.project.id));
      expect(list.body.data.conversations.map((c: {id: string}) => c.id)).toEqual([due.conversationId]);
    });

    it('wakes a conversation once when two sweeps overlap', async () => {
      const {owner, project, conversationId} = await inbox();
      const soon = new Date(Date.now() + 60_000);
      await setStatus(owner, project.id, conversationId, {status: 'SNOOZED', snoozedUntil: soon.toISOString()});

      const at = new Date(soon.getTime() + 1);
      await Promise.all([ConversationService.wakeSnoozed(at), ConversationService.wakeSnoozed(at)]);

      const wakes = (await systemLines(conversationId)).filter(
        line => (line.meta as {action: string}).action === 'reopened',
      );
      expect(wakes).toHaveLength(1);
    });
  });

  describe('assignment', () => {
    it('assigns to a support agent or the owner and unassigns', async () => {
      const {owner, project, conversationId} = await inbox();
      const agent = await addMember(project.id, true, 'Kari Nordmann');

      const toAgent = await assign(owner, project.id, conversationId, agent.id);
      expect(toAgent.status).toBe(200);
      expect(toAgent.body.data.assigneeId).toBe(agent.id);

      await assign(agent, project.id, conversationId, owner.id);
      await assign(agent, project.id, conversationId, null);

      const lines = await systemLines(conversationId);
      expect(lines.map(line => line.meta)).toEqual([
        {action: 'assigned', assignee: {id: agent.id, name: 'Kari Nordmann'}},
        {action: 'assigned', assignee: {id: owner.id, name: expect.any(String)}},
        {action: 'unassigned'},
      ]);
      expect(lines.map(line => line.authorUserId)).toEqual([owner.id, agent.id, agent.id]);
      expect((await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}})).assigneeId).toBeNull();
    });

    it('refuses anyone who is not a support agent of the project', async () => {
      const {owner, project, conversationId} = await inbox();
      const member = await addMember(project.id, false);
      const elsewhere = await messengerProject();

      for (const assigneeId of [member.id, elsewhere.owner.id, randomUUID()]) {
        const res = await assign(owner, project.id, conversationId, assigneeId);
        expect(res.status).toBe(400);
      }
      expect(await systemLines(conversationId)).toHaveLength(0);
    });

    it('lists the assignable agents', async () => {
      const {owner, project} = await inbox();
      const agent = await addMember(project.id, true, 'Kari Nordmann');
      await addMember(project.id, false, 'Not An Agent');

      const res = await request(app).get('/conversations/agents').set(asAgent(owner.id, project.id));

      expect(res.status).toBe(200);
      expect(res.body.data.map((a: {id: string}) => a.id).sort()).toEqual([owner.id, agent.id].sort());
    });

    it('hands conversations back when an agent loses access', async () => {
      const {owner, project, conversationId} = await inbox();
      const agent = await addMember(project.id, true);
      await assign(owner, project.id, conversationId, agent.id);

      await MembershipService.setSupportAgent(project.id, agent.id, false);

      expect((await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}})).assigneeId).toBeNull();
    });
  });

  describe('views and counts', () => {
    it('lists each view and counts it', async () => {
      const {owner, project, conversationId: unassigned} = await inbox();
      const contact = await factories.createContact({projectId: project.id, email: null});
      const make = (data: object) =>
        prisma.conversation.create({data: {projectId: project.id, contactId: contact.id, ...data}});
      const mine = await make({assigneeId: owner.id});
      const snoozed = await make({status: 'SNOOZED', snoozedUntil: null});
      const closed = await make({status: 'CLOSED', closedAt: new Date()});

      const ids = async (view: string) =>
        (await request(app).get(`/conversations?view=${view}`).set(asAgent(owner.id, project.id))).body.data.conversations
          .map((c: {id: string}) => c.id)
          .sort();

      expect(await ids('unassigned')).toEqual([unassigned]);
      expect(await ids('mine')).toEqual([mine.id]);
      expect(await ids('all')).toEqual([unassigned, mine.id, snoozed.id].sort());
      expect(await ids('closed')).toEqual([closed.id]);

      const counts = await request(app).get('/conversations/counts').set(asAgent(owner.id, project.id));
      expect(counts.status).toBe(200);
      expect(counts.body.data).toEqual({unassigned: 1, mine: 1, all: 3, closed: 1, cap: INBOX_COUNT_CAP});
    });

    it('pages through the All view across open and snoozed in one order', async () => {
      const {owner, project} = await messengerProject();
      const contact = await factories.createContact({projectId: project.id, email: null});
      const base = Date.now();
      await Promise.all(
        Array.from({length: 9}, (_, i) =>
          prisma.conversation.create({
            data: {
              projectId: project.id,
              contactId: contact.id,
              status: i % 2 === 0 ? 'OPEN' : 'SNOOZED',
              lastMessageAt: new Date(base - (i % 4) * 1000),
            },
          }),
        ),
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `/conversations?view=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await request(app).get(query).set(asAgent(owner.id, project.id));
        seen.push(...res.body.data.conversations.map((c: {id: string}) => c.id));
        cursor = res.body.data.nextCursor;
      } while (cursor);

      const order = await prisma.conversation.findMany({
        where: {projectId: project.id},
        orderBy: [{lastMessageAt: 'desc'}, {id: 'desc'}],
        select: {id: true},
      });
      expect(seen).toEqual(order.map(c => c.id));
    });

    it('stops counting at the cap', async () => {
      const {owner, project} = await messengerProject();
      const contact = await factories.createContact({projectId: project.id, email: null});
      await prisma.conversation.createMany({
        data: Array.from({length: INBOX_COUNT_CAP + 5}, () => ({
          projectId: project.id,
          contactId: contact.id,
          status: 'CLOSED' as const,
          replyToken: randomUUID(),
        })),
      });

      const counts = await request(app).get('/conversations/counts').set(asAgent(owner.id, project.id));

      expect(counts.body.data.closed).toBe(INBOX_COUNT_CAP);
    });
  });
});
