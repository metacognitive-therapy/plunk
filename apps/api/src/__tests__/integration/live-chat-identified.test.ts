import {Role} from '@plunk/db';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, asAgent, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Projects()]});
const prisma = getPrismaClient();
const {boot, session, startConversation} = messengerClient(app);

type Project = Awaited<ReturnType<typeof messengerProject>>['project'];

function userToken(secret: string, claims: Record<string, unknown>, options: jsonwebtoken.SignOptions = {expiresIn: '1h'}) {
  return jsonwebtoken.sign(claims, secret, {algorithm: 'HS256', ...options});
}

async function identified() {
  const {owner, project} = await messengerProject();
  const secret = await MessengerSettingsService.rotateIdentitySecret(project.id);
  return {owner, project, secret};
}

function signIn(project: Project, token: string, visitor = visitorId()) {
  return request(app)
    .post('/v1/messenger/boot')
    .set('Authorization', `Bearer ${project.public}`)
    .set('Origin', API_ORIGIN)
    .send({visitorId: visitor, parentOrigin: ALLOWED, userToken: token});
}

async function verifiedSession(project: Project, token: string, visitor = visitorId()) {
  const res = await signIn(project, token, visitor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {token: res.body.data.token as string, visitor, body: res.body.data};
}

function listAs(token: string) {
  return request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`);
}

async function listedIds(token: string): Promise<string[]> {
  const res = await listAs(token);
  expect(res.status).toBe(200);
  return (res.body.data as {id: string}[]).map(conversation => conversation.id).sort();
}

describe('Signing a visitor in with a user token', () => {
  it('gives a verified session that sees every conversation of the contact, from any device or by email', async () => {
    const {project, secret} = await identified();
    const contact = await factories.createContact({projectId: project.id, email: 'ada@example.com'});
    await prisma.contact.update({where: {id: contact.id}, data: {externalId: 'user-1'}});
    const otherDevice = await prisma.conversation.create({
      data: {projectId: project.id, contactId: contact.id, originVisitorId: visitorId()},
    });
    const byEmail = await prisma.conversation.create({
      data: {projectId: project.id, contactId: contact.id, channel: 'EMAIL'},
    });

    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-1'}));

    expect(signedIn.body.visitor).toEqual({hasEmail: true, verified: true});
    expect(signedIn.body.turnstileSiteKey).toBeNull();
    expect(await listedIds(signedIn.token)).toEqual([otherDevice.id, byEmail.id].sort());
    const reply = await request(app)
      .post(`/v1/messenger/conversations/${byEmail.id}/messages`)
      .set('Authorization', `Bearer ${signedIn.token}`)
      .send({body: 'Following up here'});
    expect(reply.status).toBe(201);
  });

  it('starts chats on the contact without tying them to the browser', async () => {
    const {project, secret} = await identified();
    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-2', email: 'grace@example.com'}));

    const started = await startConversation(signedIn.token);
    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: started.conversation.id}});
    const contact = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: 'user-2'}});
    expect(conversation.contactId).toBe(contact.id);
    expect(conversation.originVisitorId).toBeNull();

    const anonymous = await session(project.public, signedIn.visitor);
    expect(await listedIds(anonymous.token)).toEqual([]);
  });

  it('creates new contacts unsubscribed and leaves an existing subscription alone', async () => {
    const {project, secret} = await identified();
    await verifiedSession(project, userToken(secret, {sub: 'new-user', email: 'new@example.com', name: 'New User'}));
    const created = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: 'new-user'}});
    expect(created).toMatchObject({subscribed: false, email: 'new@example.com', data: {name: 'New User'}});

    const existing = await factories.createContact({projectId: project.id, email: 'reader@example.com', subscribed: true});
    await verifiedSession(project, userToken(secret, {sub: 'reader', email: 'reader@example.com'}));
    expect(await prisma.contact.findUniqueOrThrow({where: {id: existing.id}})).toMatchObject({
      subscribed: true,
      externalId: 'reader',
    });
  });

  it('refuses a token with a bad signature, no expiry, too long an expiry, no sub, or once expired', async () => {
    const {project, secret} = await identified();
    const now = Math.floor(Date.now() / 1000);
    const refused = [
      userToken('not-the-secret', {sub: 'bad-signature'}),
      userToken(secret, {sub: 'no-exp'}, {}),
      userToken(secret, {sub: 'two-hours'}, {expiresIn: '2h'}),
      userToken(secret, {email: 'nosub@example.com'}),
      userToken(secret, {sub: 'expired', exp: now - 600}, {}),
      userToken(secret, {sub: 'other-algorithm'}, {algorithm: 'HS512', expiresIn: '1h'}),
    ];
    for (const token of refused) {
      const res = await signIn(project, token);
      expect(res.status, token).toBe(401);
    }
    expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(0);
  });

  it('refuses another project’s token, and any token when no secret is set', async () => {
    const mine = await identified();
    const theirs = await identified();
    expect((await signIn(mine.project, userToken(theirs.secret, {sub: 'stranger'}))).status).toBe(401);

    const {project} = await messengerProject();
    expect((await signIn(project, userToken(mine.secret, {sub: 'stranger'}))).status).toBe(401);
    expect(await prisma.contact.count({where: {projectId: {in: [mine.project.id, project.id]}}})).toBe(0);
  });

  it('stops accepting tokens signed with a secret once it is replaced', async () => {
    const {owner, project, secret} = await identified();
    await verifiedSession(project, userToken(secret, {sub: 'user-3'}));

    const rotated = await request(app)
      .post(`/projects/${project.id}/messenger/identity-secret`)
      .set(asAgent(owner.id, project.id));
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.secret).not.toBe(secret);

    expect((await signIn(project, userToken(secret, {sub: 'user-3'}))).status).toBe(401);
    await verifiedSession(project, userToken(rotated.body.data.secret, {sub: 'user-3'}));
  });

  it('refuses an email or external id conflict without merging anyone', async () => {
    const {project, secret} = await identified();
    const taken = await factories.createContact({projectId: project.id, email: 'taken@example.com'});
    await prisma.contact.update({where: {id: taken.id}, data: {externalId: 'someone-else'}});
    const existing = await factories.createContact({projectId: project.id, email: 'mine@example.com'});
    await prisma.contact.update({where: {id: existing.id}, data: {externalId: 'user-4'}});
    const other = await factories.createContact({projectId: project.id, email: 'other@example.com'});

    const visitor = visitorId();
    const anonymous = await session(project.public, visitor);
    const chat = await startConversation(anonymous.token);
    const lead = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversation.id}});

    expect((await signIn(project, userToken(secret, {sub: 'user-5', email: 'taken@example.com'}), visitor)).status).toBe(409);
    expect((await signIn(project, userToken(secret, {sub: 'user-4', email: 'other@example.com'}), visitor)).status).toBe(409);

    expect(await prisma.contact.findUniqueOrThrow({where: {id: taken.id}})).toMatchObject({
      email: 'taken@example.com',
      externalId: 'someone-else',
    });
    expect((await prisma.contact.findUniqueOrThrow({where: {id: existing.id}})).email).toBe('mine@example.com');
    expect((await prisma.contact.findUniqueOrThrow({where: {id: other.id}})).externalId).toBeNull();
    expect(await prisma.contact.findFirst({where: {projectId: project.id, externalId: 'user-5'}})).toBeNull();
    expect((await prisma.conversation.findUniqueOrThrow({where: {id: lead.id}})).contactId).toBe(lead.contactId);
  });
});

describe('Chats started before signing in', () => {
  it('come along when the visitor’s lead is bare', async () => {
    const {project, secret} = await identified();
    const anonymous = await session(project.public);
    const chat = await startConversation(anonymous.token);
    const {contactId: leadId} = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversation.id}});

    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-6'}), anonymous.visitor);

    const contact = await prisma.contact.findFirstOrThrow({where: {projectId: project.id, externalId: 'user-6'}});
    expect((await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversation.id}})).contactId).toBe(contact.id);
    expect(await prisma.contact.findUnique({where: {id: leadId}})).toBeNull();
    expect(await listedIds(signedIn.token)).toEqual([chat.conversation.id]);
  });

  it('stay with a lead that has tags or an email, out of the signed-in user’s sight', async () => {
    const {project, secret} = await identified();
    const tag = await prisma.tag.create({data: {projectId: project.id, name: 'Trial', nameNorm: 'trial'}});
    const anonymous = await session(project.public);
    const chat = await startConversation(anonymous.token);
    const {contactId: leadId} = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversation.id}});
    await prisma.contactTag.create({data: {contactId: leadId, tagId: tag.id}});

    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-7'}), anonymous.visitor);

    expect((await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversation.id}})).contactId).toBe(leadId);
    expect(await prisma.contact.findUnique({where: {id: leadId}})).not.toBeNull();
    expect(await listedIds(signedIn.token)).toEqual([]);
    const opened = await request(app)
      .get(`/v1/messenger/conversations/${chat.conversation.id}`)
      .set('Authorization', `Bearer ${signedIn.token}`);
    expect(opened.status).toBe(404);
  });
});

describe('Sessions that are not verified', () => {
  it('still see only their own chats after giving a signed-in user’s email', async () => {
    const {project, secret} = await identified();
    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-8', email: 'user8@example.com'}));
    const theirs = await startConversation(signedIn.token);

    const stranger = await session(project.public);
    const chat = await startConversation(stranger.token);
    const captured = await request(app)
      .post('/v1/messenger/email')
      .set('Authorization', `Bearer ${chat.token}`)
      .send({email: 'user8@example.com', conversationId: chat.conversation.id});
    expect(captured.status).toBe(200);

    expect(await listedIds(captured.body.data.token)).toEqual([chat.conversation.id]);
    expect(await listedIds(signedIn.token)).toEqual([chat.conversation.id, theirs.conversation.id].sort());
  });

  it('stay verified when a signed-in user without an email gives one', async () => {
    const {project, secret} = await identified();
    const contact = await factories.createContact({projectId: project.id, email: null});
    await prisma.contact.update({where: {id: contact.id}, data: {externalId: 'user-9'}});
    const byEmail = await prisma.conversation.create({data: {projectId: project.id, contactId: contact.id, channel: 'EMAIL'}});

    const signedIn = await verifiedSession(project, userToken(secret, {sub: 'user-9'}));
    expect(signedIn.body.visitor.hasEmail).toBe(false);
    const captured = await request(app)
      .post('/v1/messenger/email')
      .set('Authorization', `Bearer ${signedIn.token}`)
      .send({email: 'user9@example.com', conversationId: byEmail.id});
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);

    expect(await listedIds(captured.body.data.token)).toEqual([byEmail.id]);
    expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).email).toBe('user9@example.com');
  });
});

describe('The identity secret', () => {
  it('is shown and replaced by admins only, and never in the settings', async () => {
    const {owner, project} = await identified();
    const member = await factories.createUser();
    await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER, supportAgent: true}});

    const path = `/projects/${project.id}/messenger/identity-secret`;
    expect((await request(app).get(path).set(asAgent(member.id, project.id))).status).toBe(403);
    expect((await request(app).post(path).set(asAgent(member.id, project.id))).status).toBe(403);

    const shown = await request(app).get(path).set(asAgent(owner.id, project.id));
    expect(shown.status).toBe(200);
    expect(shown.body.data.secret).toMatch(/^[0-9a-f]{64}$/);

    const settings = await request(app).get(`/projects/${project.id}/messenger`).set(asAgent(member.id, project.id));
    expect(settings.body.data.identityVerification).toBe(true);
    expect(JSON.stringify(settings.body)).not.toContain(shown.body.data.secret);

    const patched = await request(app)
      .patch(`/projects/${project.id}/messenger`)
      .set(asAgent(owner.id, project.id))
      .send({identitySecret: 'chosen-by-me'});
    expect(patched.status).toBe(200);
    expect(await MessengerSettingsService.identitySecret(project.id)).toBe(shown.body.data.secret);
  });

  it('is absent until created, and a plain boot keeps working', async () => {
    const {owner, project} = await messengerProject();
    const shown = await request(app)
      .get(`/projects/${project.id}/messenger/identity-secret`)
      .set(asAgent(owner.id, project.id));
    expect(shown.body.data).toEqual({secret: null});

    const res = await boot(project.public, {visitorId: visitorId(), parentOrigin: ALLOWED}, API_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.data.visitor.verified).toBe(false);
  });
});
