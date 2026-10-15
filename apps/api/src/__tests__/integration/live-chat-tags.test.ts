import {Role} from '@plunk/db';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

async function inbox() {
  const {owner, project} = await messengerProject();
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  return {owner, project, conversationId: started.conversation.id};
}

async function anotherConversation(publicKey: string) {
  const visitor = await session(publicKey);
  return (await startConversation(visitor.token, 'Another question')).conversation.id;
}

function as(agent: {id: string}, projectId: string) {
  return {
    get: (path: string) => request(app).get(path).set(asAgent(agent.id, projectId)),
    post: (path: string, body: object = {}) => request(app).post(path).set(asAgent(agent.id, projectId)).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set(asAgent(agent.id, projectId)).send(body),
    delete: (path: string) => request(app).delete(path).set(asAgent(agent.id, projectId)),
  };
}

describe('Saved replies', () => {
  it('creates, lists, edits and deletes', async () => {
    const {owner, project} = await inbox();
    const api = as(owner, project.id);

    const created = await api.post('/conversations/saved-replies', {title: 'Refunds', body: 'Refunds take 5 days.'});
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    await api.post('/conversations/saved-replies', {title: 'Account deletion', body: 'We can delete it for you.'});
    const listed = await api.get('/conversations/saved-replies');
    expect(listed.body.data.map((reply: {title: string}) => reply.title)).toEqual(['Account deletion', 'Refunds']);

    const edited = await api.patch(`/conversations/saved-replies/${id}`, {body: 'Refunds take 3 days.'});
    expect(edited.body.data).toMatchObject({title: 'Refunds', body: 'Refunds take 3 days.'});

    expect((await api.delete(`/conversations/saved-replies/${id}`)).status).toBe(200);
    expect((await api.get('/conversations/saved-replies')).body.data).toHaveLength(1);
  });

  it('rejects a body the template engine cannot parse', async () => {
    const {owner, project} = await inbox();

    const res = await as(owner, project.id).post('/conversations/saved-replies', {
      title: 'Broken',
      body: '{% if plan %}Pro',
    });
    expect(res.status).toBe(400);
  });

  it('fills in variables from the conversation contact, with fallbacks', async () => {
    const {owner, project, conversationId} = await inbox();
    const api = as(owner, project.id);
    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    const reply = await api.post('/conversations/saved-replies', {
      title: 'Greeting',
      body: 'Hi {{firstName ?? there}}, your plan is {{plan ?? unknown}}.',
    });

    const before = await api.get(`/conversations/${conversationId}/saved-replies/${reply.body.data.id}`);
    expect(before.body.data.body).toBe('Hi there, your plan is unknown.');

    await prisma.contact.update({where: {id: conversation.contactId}, data: {data: {firstName: 'Ingrid', plan: 'Pro'}}});
    const after = await api.get(`/conversations/${conversationId}/saved-replies/${reply.body.data.id}`);
    expect(after.body.data.body).toBe('Hi Ingrid, your plan is Pro.');
  });

  it('keeps each project to its own replies', async () => {
    const first = await inbox();
    const second = await inbox();
    const reply = await as(first.owner, first.project.id).post('/conversations/saved-replies', {title: 'A', body: 'B'});
    const api = as(second.owner, second.project.id);

    expect((await api.get('/conversations/saved-replies')).body.data).toEqual([]);
    expect((await api.patch(`/conversations/saved-replies/${reply.body.data.id}`, {title: 'X'})).status).toBe(404);
    expect((await api.delete(`/conversations/saved-replies/${reply.body.data.id}`)).status).toBe(404);
    expect((await api.get(`/conversations/${second.conversationId}/saved-replies/${reply.body.data.id}`)).status).toBe(
      404,
    );
  });

  it('is only for support agents', async () => {
    const {project} = await inbox();
    const member = await factories.createUser();
    await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER}});

    expect((await as(member, project.id).get('/conversations/saved-replies')).status).toBe(403);
    expect((await as(member, project.id).get('/conversations/tags')).status).toBe(403);
  });
});

describe('Conversation tags', () => {
  it('creates tags with case-insensitive names', async () => {
    const {owner, project} = await inbox();
    const api = as(owner, project.id);

    expect((await api.post('/conversations/tags', {name: '  Billing '})).body.data.name).toBe('Billing');
    expect((await api.post('/conversations/tags', {name: 'billing'})).status).toBe(409);
    await api.post('/conversations/tags', {name: 'Bug'});

    expect((await api.get('/conversations/tags')).body.data.map((tag: {name: string}) => tag.name)).toEqual([
      'Billing',
      'Bug',
    ]);
  });

  it('applies and removes tags on a conversation, idempotently', async () => {
    const {owner, project, conversationId} = await inbox();
    const api = as(owner, project.id);
    const billing = (await api.post('/conversations/tags', {name: 'Billing'})).body.data;
    const bug = (await api.post('/conversations/tags', {name: 'Bug'})).body.data;

    await api.post(`/conversations/${conversationId}/tags`, {tagId: bug.id});
    await api.post(`/conversations/${conversationId}/tags`, {tagId: billing.id});
    const again = await api.post(`/conversations/${conversationId}/tags`, {tagId: billing.id});
    expect(again.body.data).toEqual([billing, bug]);

    expect((await api.get(`/conversations/${conversationId}`)).body.data.tags).toEqual([billing, bug]);
    expect((await api.get('/conversations?view=all')).body.data.conversations[0].tags).toEqual([billing, bug]);

    const removed = await api.delete(`/conversations/${conversationId}/tags/${bug.id}`);
    expect(removed.body.data).toEqual([billing]);
  });

  it('filters every view by tag and pages through the result', async () => {
    const {owner, project, conversationId} = await inbox();
    const api = as(owner, project.id);
    const billing = (await api.post('/conversations/tags', {name: 'Billing'})).body.data;
    const others = [];
    for (let i = 0; i < 3; i++) {
      others.push(await anotherConversation(project.public));
    }
    const tagged = [conversationId, others[0]!, others[2]!];
    for (const id of tagged) {
      await api.post(`/conversations/${id}/tags`, {tagId: billing.id});
    }
    await api.post(`/conversations/${others[2]}/status`, {status: 'SNOOZED', snoozedUntil: null});
    await api.post(`/conversations/${others[0]}/status`, {status: 'CLOSED'});

    const all = await api.get(`/conversations?view=all&tag=${billing.id}`);
    expect(all.body.data.conversations.map((c: {id: string}) => c.id).sort()).toEqual(
      [conversationId, others[2]].sort(),
    );
    const closed = await api.get(`/conversations?view=closed&tag=${billing.id}`);
    expect(closed.body.data.conversations.map((c: {id: string}) => c.id)).toEqual([others[0]]);

    const firstPage = await api.get(`/conversations?view=all&tag=${billing.id}&limit=1`);
    expect(firstPage.body.data.conversations).toHaveLength(1);
    const secondPage = await api.get(
      `/conversations?view=all&tag=${billing.id}&limit=1&cursor=${firstPage.body.data.nextCursor}`,
    );
    expect(secondPage.body.data.conversations).toHaveLength(1);
    expect(secondPage.body.data.nextCursor).toBeNull();
  });

  it('deletes a tag from every conversation without touching contact tags', async () => {
    const {owner, project, conversationId} = await inbox();
    const api = as(owner, project.id);
    const second = await anotherConversation(project.public);
    const billing = (await api.post('/conversations/tags', {name: 'Billing'})).body.data;
    await api.post(`/conversations/${conversationId}/tags`, {tagId: billing.id});
    await api.post(`/conversations/${second}/tags`, {tagId: billing.id});

    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    const contactTag = await prisma.tag.create({data: {projectId: project.id, name: 'Billing', nameNorm: 'billing'}});
    await prisma.contactTag.create({data: {contactId: conversation.contactId, tagId: contactTag.id}});

    expect((await api.delete(`/conversations/tags/${billing.id}`)).status).toBe(200);

    expect(await prisma.conversationTagAssignment.count({where: {tagId: billing.id}})).toBe(0);
    expect((await api.get(`/conversations/${conversationId}`)).body.data.tags).toEqual([]);
    expect(await prisma.contactTag.count({where: {contactId: conversation.contactId, tagId: contactTag.id}})).toBe(1);
  });

  it('renames a tag, refusing a name already taken', async () => {
    const {owner, project} = await inbox();
    const api = as(owner, project.id);
    const billing = (await api.post('/conversations/tags', {name: 'Billing'})).body.data;
    await api.post('/conversations/tags', {name: 'Bug'});

    expect((await api.patch(`/conversations/tags/${billing.id}`, {name: 'BUG'})).status).toBe(409);
    expect((await api.patch(`/conversations/tags/${billing.id}`, {name: 'Payments'})).body.data.name).toBe('Payments');
  });

  it('never mixes tags or conversations across projects', async () => {
    const first = await inbox();
    const second = await inbox();
    const firstTag = (await as(first.owner, first.project.id).post('/conversations/tags', {name: 'Billing'})).body.data;
    const api = as(second.owner, second.project.id);

    expect((await api.post(`/conversations/${second.conversationId}/tags`, {tagId: firstTag.id})).status).toBe(404);
    expect((await api.delete(`/conversations/tags/${firstTag.id}`)).status).toBe(404);
    expect((await api.get(`/conversations?view=all&tag=${firstTag.id}`)).body.data.conversations).toEqual([]);
  });
});
