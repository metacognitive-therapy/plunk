import {Role} from '@plunk/db';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {QueueService} from '../../services/QueueService';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const mail = vi.hoisted(() => ({enabled: true, send: vi.fn()}));

vi.mock('@plunk/email', async importOriginal => {
  const actual = await importOriginal<typeof import('@plunk/email')>();
  return {...actual, isPlatformEmailEnabled: () => mail.enabled, sendPlatformEmail: mail.send};
});

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secretsecret';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new Projects()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

async function addMember(projectId: string, supportAgent: boolean) {
  const created = await factories.createUser();
  const user = await prisma.user.update({where: {id: created.id}, data: {emailVerified: true}});
  await prisma.membership.create({data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent}});
  return user;
}

async function team() {
  const {owner, project} = await messengerProject();
  const agent = await addMember(project.id, true);
  const member = await addMember(project.id, false);
  return {owner, project, agent, member};
}

async function visitorStarts(publicKey: string, body = 'Is the evening group still running?') {
  const visitor = await session(publicKey);
  const started = await startConversation(visitor.token, body);
  return {token: started.token, conversationId: started.conversation.id};
}

async function visitorWrites(token: string, conversationId: string, body: string) {
  const res = await request(app)
    .post(`/v1/messenger/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send({body});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function latestVisitorMessage(conversationId: string) {
  return prisma.conversationMessage.findFirstOrThrow({
    where: {conversationId, authorType: 'CONTACT'},
    orderBy: {createdAt: 'desc'},
  });
}

function emailedTo(): string[] {
  return mail.send.mock.calls.map(([to]) => to as string).sort();
}

function stubQueue() {
  return vi.spyOn(QueueService, 'queueChatNotification').mockResolvedValue(undefined as never);
}

function slackBodies(fetchSpy: ReturnType<typeof vi.spyOn>) {
  return fetchSpy.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

beforeEach(() => {
  mail.enabled = true;
  mail.send.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Emailing agents about unread visitor messages', () => {
  it('schedules the email after the project delay, and nothing when platform mail is off', async () => {
    const queue = stubQueue();
    const {project} = await messengerProject();
    await MessengerSettingsService.update(project.id, {emailDelayMinutes: 7});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);

    expect(queue).toHaveBeenCalledWith({type: 'agent_email', messageId: message.id}, {delay: 7 * 60_000});

    queue.mockClear();
    mail.enabled = false;
    const second = await visitorStarts(project.public);
    const secondMessage = await latestVisitorMessage(second.conversationId);
    expect(queue).not.toHaveBeenCalledWith(expect.objectContaining({type: 'agent_email'}), expect.anything());
    expect(await ChatNotificationService.process({type: 'agent_email', messageId: secondMessage.id})).toEqual({sent: 0});
  });

  it('emails every support agent while unassigned, skipping members, outsiders and agents who opted out', async () => {
    stubQueue();
    const {owner, project, agent} = await team();
    const optedOut = await addMember(project.id, true);
    await prisma.user.update({where: {id: optedOut.id}, data: {inboxEmail: false}});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);

    expect(await ChatNotificationService.process({type: 'agent_email', messageId: message.id})).toEqual({sent: 2});
    expect(emailedTo()).toEqual([owner.email, agent.email].sort());

    const [, subject, template] = mail.send.mock.calls[0]!;
    expect(subject).toContain('is waiting for a reply');
    expect(template.props.messages).toEqual(['Is the evening group still running?']);
    expect(template.props.conversationUrl).toContain(`/inbox?project=${project.id}&view=all&c=${conversationId}`);
  });

  it('emails only the assignee once the conversation is assigned', async () => {
    stubQueue();
    const {owner, project, agent} = await team();
    const {conversationId} = await visitorStarts(project.public);
    await request(app).post(`/conversations/${conversationId}/assignee`).set(asAgent(owner.id, project.id)).send({assigneeId: agent.id});
    const message = await latestVisitorMessage(conversationId);

    expect(await ChatNotificationService.process({type: 'agent_email', messageId: message.id})).toEqual({sent: 1});
    expect(emailedTo()).toEqual([agent.email]);
    expect(mail.send.mock.calls[0]![2].props.assignedToYou).toBe(true);
  });

  it('sends nothing when an agent read the message before the delay ended', async () => {
    stubQueue();
    const {owner, project} = await team();
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);
    expect((await request(app).post(`/conversations/${conversationId}/read`).set(asAgent(owner.id, project.id))).status).toBe(200);

    expect(await ChatNotificationService.process({type: 'agent_email', messageId: message.id})).toEqual({sent: 0});
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sends one email for a burst of messages, with the burst in it', async () => {
    stubQueue();
    const {project} = await messengerProject();
    const {token, conversationId} = await visitorStarts(project.public, 'Hello?');
    const second = await visitorWrites(token, conversationId, 'Is anyone there?');
    const third = await visitorWrites(token, conversationId, 'I need to move my session.');
    const first = (await prisma.conversationMessage.findFirstOrThrow({where: {conversationId, body: 'Hello?'}})).id;

    const results = [];
    for (const messageId of [first, second, third]) {
      results.push(await ChatNotificationService.process({type: 'agent_email', messageId}));
    }
    expect(results).toEqual([{sent: 1}, {sent: 0}, {sent: 0}]);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0]![2].props.messages).toEqual(['Hello?', 'Is anyone there?', 'I need to move my session.']);
  });

  it('starts a new burst after an agent replies or reads', async () => {
    stubQueue();
    const {owner, project} = await messengerProject();
    const {token, conversationId} = await visitorStarts(project.public, 'First question');
    const first = await latestVisitorMessage(conversationId);
    await ChatNotificationService.process({type: 'agent_email', messageId: first.id});

    const reply = await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(asAgent(owner.id, project.id))
      .send({body: 'Answered!'});
    expect(reply.status).toBe(201);
    const afterReply = await visitorWrites(token, conversationId, 'Follow-up after the reply');
    expect(await ChatNotificationService.process({type: 'agent_email', messageId: afterReply})).toEqual({sent: 1});
    expect(mail.send.mock.calls[1]![2].props.messages).toEqual(['Follow-up after the reply']);

    await visitorWrites(token, conversationId, 'Read but not answered');
    await request(app).post(`/conversations/${conversationId}/read`).set(asAgent(owner.id, project.id));
    const afterRead = await visitorWrites(token, conversationId, 'Follow-up after the read');
    expect(await ChatNotificationService.process({type: 'agent_email', messageId: afterRead})).toEqual({sent: 1});
    expect(mail.send).toHaveBeenCalledTimes(3);
    expect(mail.send.mock.calls[2]![2].props.messages).toEqual(['Follow-up after the read']);
  });

  it('sends nothing for a conversation that was closed or answered in the meantime', async () => {
    stubQueue();
    const {owner, project} = await messengerProject();
    const closed = await visitorStarts(project.public);
    await request(app).post(`/conversations/${closed.conversationId}/status`).set(asAgent(owner.id, project.id)).send({status: 'CLOSED'});
    const closedMessage = await latestVisitorMessage(closed.conversationId);
    expect(await ChatNotificationService.process({type: 'agent_email', messageId: closedMessage.id})).toEqual({sent: 0});

    const answered = await visitorStarts(project.public);
    const answeredMessage = await latestVisitorMessage(answered.conversationId);
    await request(app).post(`/conversations/${answered.conversationId}/messages`).set(asAgent(owner.id, project.id)).send({body: 'Hi!'});
    expect(await ChatNotificationService.process({type: 'agent_email', messageId: answeredMessage.id})).toEqual({sent: 0});
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('Slack notifications', () => {
  it('queues a Slack post only when a webhook is saved', async () => {
    const queue = stubQueue();
    const {project} = await messengerProject();
    await visitorStarts(project.public);
    expect(queue).not.toHaveBeenCalledWith(expect.objectContaining({type: 'slack'}));

    await MessengerSettingsService.update(project.id, {slackWebhookUrl: WEBHOOK});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);
    expect(queue).toHaveBeenCalledWith({type: 'slack', messageId: message.id});
  });

  it('posts a new conversation with a link to the inbox', async () => {
    stubQueue();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', {status: 200}));
    const {project} = await messengerProject();
    await MessengerSettingsService.update(project.id, {slackWebhookUrl: WEBHOOK});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);

    expect(await ChatNotificationService.process({type: 'slack', messageId: message.id})).toEqual({posted: true});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect((init as RequestInit).redirect).toBe('manual');
    const body = slackBodies(fetchSpy)[0];
    expect(body.text).toContain('New conversation from A visitor');
    expect(body.blocks[1]).toEqual({type: 'section', text: {type: 'plain_text', text: 'Is the evening group still running?', emoji: false}});
    expect(body.blocks[2].elements[0].url).toContain(`/inbox?project=${project.id}&view=all&c=${conversationId}`);
    expect(JSON.stringify(body)).not.toContain('Plunk');
  });

  it('posts replies only while the conversation is unassigned', async () => {
    stubQueue();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', {status: 200}));
    const {owner, project} = await messengerProject();
    await MessengerSettingsService.update(project.id, {slackWebhookUrl: WEBHOOK});
    const {token, conversationId} = await visitorStarts(project.public);

    const unassigned = await visitorWrites(token, conversationId, 'Anyone?');
    expect(await ChatNotificationService.process({type: 'slack', messageId: unassigned})).toEqual({posted: true});
    expect(slackBodies(fetchSpy)[0].text).toContain('New reply');

    await request(app).post(`/conversations/${conversationId}/assignee`).set(asAgent(owner.id, project.id)).send({assigneeId: owner.id});
    const assigned = await visitorWrites(token, conversationId, 'Thanks');
    expect(await ChatNotificationService.process({type: 'slack', messageId: assigned})).toEqual({posted: false});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cannot ping the channel from visitor-controlled text', async () => {
    stubQueue();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', {status: 200}));
    const {project} = await messengerProject();
    await MessengerSettingsService.update(project.id, {slackWebhookUrl: WEBHOOK});
    const {conversationId} = await visitorStarts(project.public, '<!channel> urgent <https://evil.example|click>');
    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    await prisma.contact.update({where: {id: conversation.contactId}, data: {data: {firstName: '<!here>'}}});
    const message = await latestVisitorMessage(conversationId);

    await ChatNotificationService.process({type: 'slack', messageId: message.id});
    const body = slackBodies(fetchSpy)[0];
    expect(body.text).not.toContain('<!');
    expect(body.text).toContain('&lt;!here&gt;');
    expect(body.blocks[0].text.text).not.toContain('<!');
    expect(body.blocks[1].text.type).toBe('plain_text');
  });

  it('logs a failing webhook without throwing, so the job is not retried', async () => {
    stubQueue();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    const {project} = await messengerProject();
    await MessengerSettingsService.update(project.id, {slackWebhookUrl: WEBHOOK});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);

    await expect(ChatNotificationService.process({type: 'slack', messageId: message.id})).resolves.toEqual({posted: false});
    expect(await prisma.conversationMessage.count({where: {conversationId}})).toBeGreaterThan(0);
  });

  it('never posts to a URL that is not a Slack webhook, even one written straight to the database', async () => {
    stubQueue();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const {project} = await messengerProject();
    await prisma.messengerSettings.update({where: {projectId: project.id}, data: {slackWebhookUrl: 'http://169.254.169.254/latest'}});
    const {conversationId} = await visitorStarts(project.public);
    const message = await latestVisitorMessage(conversationId);

    expect(await ChatNotificationService.process({type: 'slack', messageId: message.id})).toEqual({posted: false});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Slack settings', () => {
  it('accepts only Slack webhook URLs and never returns the saved one', async () => {
    const {owner, project} = await messengerProject();
    const headers = asAgent(owner.id, project.id);

    for (const url of ['https://example.com/services/x', 'http://hooks.slack.com/services/x', 'https://hooks.slack.com.evil.com/services/x']) {
      const res = await request(app).patch(`/projects/${project.id}/messenger`).set(headers).send({slackWebhookUrl: url});
      expect(res.status, url).toBe(422);
    }

    const saved = await request(app).patch(`/projects/${project.id}/messenger`).set(headers).send({slackWebhookUrl: WEBHOOK});
    expect(saved.status).toBe(200);
    expect(saved.body.data.slackConnected).toBe(true);
    const read = await request(app).get(`/projects/${project.id}/messenger`).set(headers);
    expect(read.body.data.slackConnected).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain('hooks.slack.com');

    const boot = await request(app)
      .post('/v1/messenger/boot')
      .set('Authorization', `Bearer ${project.public}`)
      .send({visitorId: 'v_slackcheck0000000000', parentOrigin: 'https://www.example.com'});
    expect(JSON.stringify(boot.body)).not.toContain('hooks.slack.com');

    const cleared = await request(app).patch(`/projects/${project.id}/messenger`).set(headers).send({slackWebhookUrl: null});
    expect(cleared.body.data.slackConnected).toBe(false);
  });

  it('sends a test post and reports Slack refusing it', async () => {
    const {owner, project, agent} = await team();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', {status: 200}))
      .mockResolvedValueOnce(new Response('no_service', {status: 404}));

    const ok = await request(app).post(`/projects/${project.id}/messenger/slack/test`).set(asAgent(owner.id, project.id)).send({url: WEBHOOK});
    expect(ok.status).toBe(200);
    const refused = await request(app).post(`/projects/${project.id}/messenger/slack/test`).set(asAgent(owner.id, project.id)).send({url: WEBHOOK});
    expect(refused.status).toBe(400);
    expect(refused.body.message ?? refused.body.error?.message).toContain('no_service');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const notAdmin = await request(app).post(`/projects/${project.id}/messenger/slack/test`).set(asAgent(agent.id, project.id)).send({url: WEBHOOK});
    expect(notAdmin.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
