import {WorkflowExecutionStatus, WorkflowTriggerType} from '@plunk/db';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {ContactService} from '../../services/ContactService';
import {EventService} from '../../services/EventService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, asAgent, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Projects()]});
const prisma = getPrismaClient();
const {session} = messengerClient(app);

async function signedIn(userAttributes: string[] = ['plan', 'completed_modules_count', 'is_premium', 'locale']) {
  const {owner, project} = await messengerProject();
  const secret = await MessengerSettingsService.rotateIdentitySecret(project.id);
  await MessengerSettingsService.update(project.id, {userAttributes});
  const res = await request(app)
    .post('/v1/messenger/boot')
    .set('Authorization', `Bearer ${project.public}`)
    .set('Origin', API_ORIGIN)
    .send({
      visitorId: visitorId(),
      parentOrigin: ALLOWED,
      userToken: jsonwebtoken.sign({sub: 'user-1', name: 'Ada'}, secret, {algorithm: 'HS256', expiresIn: '1h'}),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const contact = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: 'user-1'}});
  return {owner, project, token: res.body.data.token as string, contact};
}

const updateUser = (token: string, attributes: unknown) =>
  request(app).post('/v1/messenger/user').set('Authorization', `Bearer ${token}`).send({attributes});

const logEvent = (token: string, body: unknown) =>
  request(app).post('/v1/messenger/events').set('Authorization', `Bearer ${token}`).send(body);

const dataOf = (contactId: string) =>
  prisma.contact.findUniqueOrThrow({where: {id: contactId}}).then(contact => contact.data as Record<string, unknown>);

describe('updateUser from the SDK', () => {
  it('merges declared attributes into the signed-in contact and removes nulls', async () => {
    const user = await signedIn();

    expect((await updateUser(user.token, {plan: 'pro', completed_modules_count: 3, is_premium: true})).status).toBe(200);
    expect(await dataOf(user.contact.id)).toMatchObject({name: 'Ada', plan: 'pro', completed_modules_count: 3, is_premium: true});

    expect((await updateUser(user.token, {plan: null})).status).toBe(200);
    const data = await dataOf(user.contact.id);
    expect(data).not.toHaveProperty('plan');
    expect(data).toMatchObject({completed_modules_count: 3});
  });

  it('refuses the whole update when any attribute is undeclared', async () => {
    const user = await signedIn();

    const res = await updateUser(user.token, {plan: 'pro', favourite_colour: 'teal'});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/favourite_colour.*Settings > Messenger/);
    expect(await dataOf(user.contact.id)).not.toHaveProperty('plan');
  });

  it('refuses everything while no attribute is declared, and anything but flat values', async () => {
    const user = await signedIn([]);
    expect((await updateUser(user.token, {plan: 'pro'})).status).toBe(422);

    await MessengerSettingsService.update(user.project.id, {userAttributes: ['plan', 'locale']});
    expect((await updateUser(user.token, {plan: {tier: 'pro'}})).status).toBe(422);
    expect((await updateUser(user.token, {locale: 7})).status).toBe(422);
    expect((await updateUser(user.token, {})).status).toBe(422);
  });

  it('refuses anonymous sessions and erased contacts', async () => {
    const user = await signedIn();
    const anonymous = await session(user.project.public);
    expect((await updateUser(anonymous.token, {plan: 'pro'})).status).toBe(403);

    await ContactService.anonymizeByExternalId(user.project.id, 'user-1');
    expect((await updateUser(user.token, {plan: 'pro'})).status).toBe(409);
  });
});

describe('logEvent from the SDK', () => {
  it('records the event on the signed-in contact and starts a workflow on it', async () => {
    const user = await signedIn();
    const workflow = await factories.createWorkflow({
      projectId: user.project.id,
      enabled: true,
      triggerType: WorkflowTriggerType.EVENT,
      triggerConfig: {eventName: 'finished_journey_module'},
    });
    await EventService.invalidateWorkflowCache(user.project.id);
    const occurredAt = new Date(Date.now() - 60 * 60_000);

    const res = await logEvent(user.token, {name: 'finished_journey_module', data: {module_id: 'm-4'}, occurredAt: occurredAt.toISOString()});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const event = await prisma.event.findFirstOrThrow({where: {projectId: user.project.id, name: 'finished_journey_module'}});
    expect(event).toMatchObject({contactId: user.contact.id, data: {module_id: 'm-4'}});
    expect(event.occurredAt.getTime()).toBe(occurredAt.getTime());
    expect(await dataOf(user.contact.id)).not.toHaveProperty('module_id');

    const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
    expect(executions).toHaveLength(1);
    expect(executions[0]!.contactId).toBe(user.contact.id);
    expect([WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.WAITING, WorkflowExecutionStatus.COMPLETED]).toContain(
      executions[0]!.status,
    );
  });

  it('refuses anonymous sessions, reserved names, bad names and future times', async () => {
    const user = await signedIn();
    const anonymous = await session(user.project.public);

    expect((await logEvent(anonymous.token, {name: 'signed_up'})).status).toBe(403);
    expect((await logEvent(user.token, {name: 'conversation.closed'})).status).toBe(422);
    expect((await logEvent(user.token, {name: 'email.opened'})).status).toBe(422);
    expect((await logEvent(user.token, {name: 'has spaces'})).status).toBe(422);
    expect((await logEvent(user.token, {name: 'signed_up', occurredAt: new Date(Date.now() + 86_400_000).toISOString()})).status).toBe(
      422,
    );
    expect(await prisma.event.count({where: {projectId: user.project.id, name: {in: ['signed_up', 'has spaces']}}})).toBe(0);
  });
});

describe('Declaring user attributes', () => {
  it('saves a list of unique attribute names and refuses platform-managed ones', async () => {
    const {owner, project} = await messengerProject();
    const path = `/projects/${project.id}/messenger`;
    const headers = asAgent(owner.id, project.id);

    const saved = await request(app).patch(path).set(headers).send({userAttributes: ['plan', 'is_premium']});
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.userAttributes).toEqual(['plan', 'is_premium']);

    expect((await request(app).patch(path).set(headers).send({userAttributes: ['email']})).status).toBe(422);
    expect((await request(app).patch(path).set(headers).send({userAttributes: ['plan', 'plan']})).status).toBe(422);
    expect((await request(app).patch(path).set(headers).send({userAttributes: ['1st-plan']})).status).toBe(422);
    expect((await request(app).get(path).set(headers)).body.data.userAttributes).toEqual(['plan', 'is_premium']);
  });
});
