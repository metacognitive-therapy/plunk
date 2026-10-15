import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {Role} from '@plunk/db';
import request from 'supertest';
import {beforeAll, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {widgetRouter} from '../../app/widget';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {Users} from '../../controllers/Users';
import {MembershipService} from '../../services/MembershipService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, asAgent, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Projects(), new Users()]});
const prisma = getPrismaClient();
const {boot} = messengerClient(app);

async function appearanceOf(publicKey: string) {
  const res = await boot(publicKey, {visitorId: visitorId(), parentOrigin: ALLOWED}, API_ORIGIN);
  expect(res.status).toBe(200);
  return res.body.data.appearance;
}

async function addMember(projectId: string, options: {name?: string | null; supportAgent?: boolean} = {}) {
  const user = await factories.createUser();
  await prisma.user.update({where: {id: user.id}, data: {name: options.name ?? null, emailVerified: true}});
  await prisma.membership.create({
    data: {userId: user.id, projectId, role: Role.MEMBER, supportAgent: options.supportAgent ?? true},
  });
  return user;
}

describe('Live chat messenger appearance', () => {
  it('boots with the default appearance', async () => {
    const {project} = await messengerProject();

    expect(await appearanceOf(project.public)).toEqual({
      accentColor: '#111827',
      launcherPosition: 'RIGHT',
      greeting: null,
      team: [],
    });
  });

  it('reflects saved appearance on the next boot', async () => {
    const {owner, project} = await messengerProject();
    await appearanceOf(project.public);

    const res = await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send({accentColor: '#FF5500', launcherPosition: 'LEFT', greeting: '  Hi there, ask us anything  '});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({accentColor: '#ff5500', launcherPosition: 'LEFT', greeting: 'Hi there, ask us anything'});
    expect(await appearanceOf(project.public)).toMatchObject({
      accentColor: '#ff5500',
      launcherPosition: 'LEFT',
      greeting: 'Hi there, ask us anything',
    });
  });

  it('clears the greeting when it is saved empty', async () => {
    const {owner, project} = await messengerProject();
    const save = (greeting: string) =>
      request(app).patch(`/projects/${project.id}/messenger`).set(asAgent(owner.id, project.id)).send({greeting});

    await save('Hello');
    expect((await save('   ')).body.data.greeting).toBeNull();
  });

  it.each([
    {accentColor: 'red'},
    {accentColor: '#12345'},
    {launcherPosition: 'TOP'},
    {greeting: 'x'.repeat(81)},
    {teamUserIds: ['not-a-uuid']},
  ])('rejects invalid appearance %o', async body => {
    const {owner, project} = await messengerProject();

    const res = await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send(body);

    expect(res.status).toBe(422);
  });

  it('refuses team avatars for people who are not support agents', async () => {
    const {owner, project} = await messengerProject();
    const member = await addMember(project.id, {name: 'Nina', supportAgent: false});
    const {user: outsider} = await factories.createUserWithProject();

    for (const id of [member.id, outsider.id]) {
      const res = await request(app)
        .patch(`/projects/${project.id}/messenger`)
        .set(asAgent(owner.id, project.id))
        .send({teamUserIds: [id]});
      expect(res.status).toBe(400);
    }
  });

  it('shows named agents in the chosen order and leaves out nameless ones', async () => {
    const {owner, project} = await messengerProject();
    const maria = await addMember(project.id, {name: 'Maria'});
    const nameless = await addMember(project.id);
    await prisma.user.update({where: {id: owner.id}, data: {name: 'Olav'}});

    const res = await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send({teamUserIds: [maria.id, nameless.id, owner.id, maria.id]});

    expect(res.status).toBe(200);
    expect(res.body.data.teamUserIds).toEqual([maria.id, nameless.id, owner.id]);
    expect((await appearanceOf(project.public)).team).toEqual([
      {id: maria.id, name: 'Maria'},
      {id: owner.id, name: 'Olav'},
    ]);
  });

  it('updates the team when an agent names themselves or loses inbox access', async () => {
    const {owner, project} = await messengerProject();
    const agent = await addMember(project.id);
    const maria = await addMember(project.id, {name: 'Maria'});
    await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send({teamUserIds: [agent.id, maria.id]});
    expect((await appearanceOf(project.public)).team).toEqual([{id: maria.id, name: 'Maria'}]);

    const named = await request(app).patch('/users/@me').set(asAgent(agent.id, project.id)).send({name: 'Ana'});
    expect(named.status).toBe(200);
    await MembershipService.setSupportAgent(project.id, maria.id, false);

    expect((await appearanceOf(project.public)).team).toEqual([{id: agent.id, name: 'Ana'}]);
  });

  it('never exposes agent emails to the visitor', async () => {
    const {owner, project} = await messengerProject();
    await prisma.user.update({where: {id: owner.id}, data: {name: 'Olav'}});
    await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send({teamUserIds: [owner.id]});

    const res = await boot(project.public, {visitorId: visitorId(), parentOrigin: ALLOWED}, API_ORIGIN);
    expect(JSON.stringify(res.body)).not.toContain(owner.email);
  });
});

describe('Profile name', () => {
  it('sets, trims and clears the signed-in user name', async () => {
    const {owner, project} = await messengerProject();
    const headers = asAgent(owner.id, project.id);

    const set = await request(app).patch('/users/@me').set(headers).send({name: '  Maria Hansen  '});
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({id: owner.id, name: 'Maria Hansen'});
    expect((await request(app).get('/users/@me').set(headers)).body.name).toBe('Maria Hansen');

    const cleared = await request(app).patch('/users/@me').set(headers).send({name: ''});
    expect(cleared.body.name).toBeNull();
    expect((await request(app).get('/users/@me').set(headers)).body.name).toBeNull();
  });

  it('rejects names over 60 characters and anonymous callers', async () => {
    const {owner, project} = await messengerProject();

    const long = await request(app)
      .patch('/users/@me')
      .set(asAgent(owner.id, project.id))
      .send({name: 'x'.repeat(61)});
    expect(long.status).toBe(422);
    expect((await request(app).patch('/users/@me').send({name: 'Eve'})).status).toBe(401);
  });

  it('lists member names for the team picker', async () => {
    const {owner, project} = await messengerProject();
    await addMember(project.id, {name: 'Maria'});

    const res = await request(app).get(`/projects/${project.id}/members`).set(asAgent(owner.id, project.id));

    expect(res.status).toBe(200);
    const names = (res.body.data ?? res.body).map((m: {name: string | null}) => m.name);
    expect(names).toContain('Maria');
  });
});

describe('Widget loader', () => {
  let widgetApp: ReturnType<typeof buildHttpApp>;

  beforeAll(async () => {
    const dist = await mkdtemp(path.join(tmpdir(), 'plunk-loader-'));
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(dist, 'loader.js'), '(function(){})();');
    widgetApp = buildHttpApp({routers: {'/widget': widgetRouter({distDir: dist})}});
  });

  it('serves the loader to any site with a short cache', async () => {
    const res = await request(widgetApp).get('/widget/loader.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});
