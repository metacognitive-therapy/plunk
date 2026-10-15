import {Role, WorkflowExecutionStatus, WorkflowTriggerType} from '@plunk/db';
import {CHAT_EVENT_NAMES, CHAT_EVENTS} from '@plunk/shared';
import request from 'supertest';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Contacts} from '../../controllers/Contacts';
import {Conversations} from '../../controllers/Conversations';
import {Events} from '../../controllers/Events';
import {Messenger} from '../../controllers/Messenger';
import {EventService} from '../../services/EventService';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new Events(), new Contacts()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

async function chat() {
  const {owner, project} = await messengerProject();
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: started.conversation.id}});
  return {owner, project, visitor, token: started.token, conversation};
}

function chatEvents(contactId: string) {
  return prisma.event.findMany({
    where: {contactId, name: {in: [...CHAT_EVENT_NAMES]}},
    orderBy: {createdAt: 'asc'},
  });
}

function setStatus(agent: {id: string}, projectId: string, conversationId: string, status: string) {
  return request(app).post(`/conversations/${conversationId}/status`).set(asAgent(agent.id, projectId)).send({status});
}

function visitorWrites(token: string, conversationId: string, body = 'Any news?') {
  return request(app)
    .post(`/v1/messenger/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send({body});
}

async function addMember(projectId: string, supportAgent: boolean) {
  const user = await factories.createUser();
  await prisma.user.update({where: {id: user.id}, data: {emailVerified: true}});
  await prisma.membership.create({data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent}});
  return user;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conversation events', () => {
  it('records started, replied and closed once each, with the conversation in the payload', async () => {
    const {owner, project, token, conversation} = await chat();

    await request(app)
      .post(`/conversations/${conversation.id}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Hi, how can we help?'});
    expect((await visitorWrites(token, conversation.id)).status).toBe(201);
    expect((await setStatus(owner, project.id, conversation.id, 'CLOSED')).status).toBe(200);
    expect((await setStatus(owner, project.id, conversation.id, 'CLOSED')).status).toBe(200);

    const events = await chatEvents(conversation.contactId);
    expect(events.map(event => event.name)).toEqual([CHAT_EVENTS.STARTED, CHAT_EVENTS.REPLIED, CHAT_EVENTS.CLOSED]);
    for (const event of events) {
      expect(event.projectId).toBe(project.id);
      expect(event.data).toMatchObject({conversationId: conversation.id, channel: 'WIDGET'});
    }
  });

  it('records a reply that reopens a closed conversation, and a second close', async () => {
    const {owner, project, token, conversation} = await chat();
    await setStatus(owner, project.id, conversation.id, 'CLOSED');
    await visitorWrites(token, conversation.id, 'One more thing');
    await setStatus(owner, project.id, conversation.id, 'CLOSED');

    const names = (await chatEvents(conversation.contactId)).map(event => event.name);
    expect(names).toEqual([CHAT_EVENTS.STARTED, CHAT_EVENTS.CLOSED, CHAT_EVENTS.REPLIED, CHAT_EVENTS.CLOSED]);
  });

  it('does not record events for agent replies, notes or snoozes', async () => {
    const {owner, project, conversation} = await chat();
    const agent = asAgent(owner.id, project.id);
    await request(app).post(`/conversations/${conversation.id}/messages`).set(agent).send({body: 'On it'});
    await request(app).post(`/conversations/${conversation.id}/notes`).set(agent).send({body: 'Internal'});
    await request(app)
      .post(`/conversations/${conversation.id}/status`)
      .set(agent)
      .send({status: 'SNOOZED', until: new Date(Date.now() + 3_600_000).toISOString()});

    expect((await chatEvents(conversation.contactId)).map(event => event.name)).toEqual([CHAT_EVENTS.STARTED]);
  });

  it('keeps the message when recording the event fails', async () => {
    vi.spyOn(EventService, 'trackEvent').mockRejectedValue(new Error('db down'));
    const {project} = await messengerProject();
    const visitor = await session(project.public);
    const started = await startConversation(visitor.token, 'Still saved?');

    expect(started.conversation.messages.map(message => message.body)).toEqual(['Still saved?']);
  });

  it('starts a workflow triggered by conversation.closed for the contact', async () => {
    const {owner, project, conversation} = await chat();
    const workflow = await factories.createWorkflow({
      projectId: project.id,
      enabled: true,
      triggerType: WorkflowTriggerType.EVENT,
      triggerConfig: {eventName: CHAT_EVENTS.CLOSED},
    });
    await EventService.invalidateWorkflowCache(project.id);

    await setStatus(owner, project.id, conversation.id, 'CLOSED');

    const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
    expect(executions).toHaveLength(1);
    expect(executions[0]!.contactId).toBe(conversation.contactId);
    expect([
      WorkflowExecutionStatus.RUNNING,
      WorkflowExecutionStatus.WAITING,
      WorkflowExecutionStatus.COMPLETED,
    ]).toContain(executions[0]!.status);
  });

  it('offers the chat events in the workflow event picker while the messenger is on', async () => {
    const {owner, project} = await messengerProject();
    const res = await request(app).get('/events/names').set(asAgent(owner.id, project.id));
    expect(res.status).toBe(200);
    expect(res.body.eventNames).toEqual(expect.arrayContaining([...CHAT_EVENT_NAMES]));

    const off = await messengerProject({enabled: false});
    const hidden = await request(app).get('/events/names').set(asAgent(off.owner.id, off.project.id));
    expect(hidden.body.eventNames).not.toContain(CHAT_EVENTS.CLOSED);
  });

  it('reserves the chat event names from the public track API', () => {
    for (const name of CHAT_EVENT_NAMES) {
      expect(EventService.isReservedEvent(name)).toBe(true);
    }
  });
});

describe('GET /conversations/:id/contact', () => {
  it('returns the contact with tags, segments, recent events and other conversations', async () => {
    const {owner, project, visitor, conversation} = await chat();
    const contactId = conversation.contactId;
    await prisma.contact.update({where: {id: contactId}, data: {data: {plan: 'pro'}}});

    const tag = await prisma.tag.create({data: {projectId: project.id, name: 'VIP', nameNorm: 'vip'}});
    await prisma.contactTag.create({data: {contactId, tagId: tag.id}});
    const segment = await factories.createSegment(project.id, {name: 'Leads'});
    const left = await factories.createSegment(project.id, {name: 'Former'});
    await prisma.segmentMembership.createMany({
      data: [
        {contactId, segmentId: segment.id},
        {contactId, segmentId: left.id, exitedAt: new Date()},
      ],
    });
    await setStatus(owner, project.id, conversation.id, 'CLOSED');
    const second = await startConversation(visitor.token, 'A new question');

    const res = await request(app)
      .get(`/conversations/${second.conversation.id}/contact`)
      .set(asAgent(owner.id, project.id));
    expect(res.status).toBe(200);
    const profile = res.body.data;
    expect(profile).toMatchObject({id: contactId, subscribed: false, data: {plan: 'pro'}});
    expect(profile.tags).toEqual([{id: tag.id, name: 'VIP'}]);
    expect(profile.segments).toEqual([{id: segment.id, name: 'Leads'}]);
    expect(profile.events[0].name).toBe(CHAT_EVENTS.STARTED);
    expect(profile.events.map((event: {name: string}) => event.name)).toContain(CHAT_EVENTS.CLOSED);
    expect(profile.conversations).toEqual([
      expect.objectContaining({
        id: conversation.id,
        status: 'CLOSED',
        lastMessage: expect.objectContaining({body: 'Hello, I need help'}),
      }),
    ]);
  });

  it('is limited to support agents of the conversation’s project', async () => {
    const {project, conversation} = await chat();
    const member = await addMember(project.id, false);
    const denied = await request(app)
      .get(`/conversations/${conversation.id}/contact`)
      .set(asAgent(member.id, project.id));
    expect(denied.status).toBe(403);

    const other = await messengerProject();
    const missing = await request(app)
      .get(`/conversations/${conversation.id}/contact`)
      .set(asAgent(other.owner.id, other.project.id));
    expect(missing.status).toBe(404);
  });
});

describe('GET /contacts/:id/conversations', () => {
  it('shows support agents the conversations with their last message', async () => {
    const {project, conversation} = await chat();
    const agent = await addMember(project.id, true);

    const res = await request(app)
      .get(`/contacts/${conversation.contactId}/conversations`)
      .set(asAgent(agent.id, project.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({canOpen: true, total: 1});
    expect(res.body.data.conversations[0]).toMatchObject({
      id: conversation.id,
      status: 'OPEN',
      lastMessage: {body: 'Hello, I need help', authorType: 'CONTACT'},
    });
  });

  it('shows other members that conversations exist without their text', async () => {
    const {project, conversation} = await chat();
    const member = await addMember(project.id, false);

    const res = await request(app)
      .get(`/contacts/${conversation.contactId}/conversations`)
      .set(asAgent(member.id, project.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({canOpen: false, total: 1});
    expect(res.body.data.conversations[0]).toMatchObject({id: conversation.id, status: 'OPEN', lastMessage: null});
    expect(JSON.stringify(res.body)).not.toContain('Hello, I need help');
  });

  it('does not show another project’s contact', async () => {
    const {conversation} = await chat();
    const other = await messengerProject();
    const res = await request(app)
      .get(`/contacts/${conversation.contactId}/conversations`)
      .set(asAgent(other.owner.id, other.project.id));
    expect(res.status).toBe(404);
  });
});
