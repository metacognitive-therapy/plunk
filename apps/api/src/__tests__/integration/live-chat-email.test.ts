import {CONTACT_IDENTITY_TYPES} from '@plunk/shared';
import request from 'supertest';
import {describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {isTransactionallyMailableContact} from '../../database/contact-filters';
import {ContactService} from '../../services/ContactService';
import {EventService} from '../../services/EventService';
import {EMAIL_CAPTURED_EVENT, MessengerContactService} from '../../services/MessengerContactService';
import {MessengerSessionService} from '../../services/MessengerSessionService';
import {buildHttpApp} from '../helpers/httpApp';
import {ALLOWED, API_ORIGIN, messengerClient, messengerProject, visitorId} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations()]});
const prisma = getPrismaClient();
const {boot, session, startConversation} = messengerClient(app);

function captureEmail(token: string, body: {email: string; conversationId: string; subscribe?: boolean}) {
  return request(app).post('/v1/messenger/email').set('Authorization', `Bearer ${token}`).send(body);
}

async function visitorWithConversation(publicKey: string) {
  const visitor = await session(publicKey);
  const started = await startConversation(visitor.token);
  const lead = await prisma.conversation.findUniqueOrThrow({where: {id: started.conversation.id}});
  return {visitor: visitor.visitor, token: started.token, conversationId: started.conversation.id, leadId: lead.contactId};
}

async function capturedEvents(contactId: string) {
  return prisma.event.findMany({where: {contactId, name: EMAIL_CAPTURED_EVENT}});
}

describe('Live chat email capture', () => {
  it('sets a new address on the lead, unsubscribed, without creating a contact', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);
    const before = await prisma.contact.count({where: {projectId: project.id}});

    const res = await captureEmail(chat.token, {email: '  New.Visitor@Example.com ', conversationId: chat.conversationId});

    expect(res.status).toBe(200);
    expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(before);
    const lead = await prisma.contact.findUniqueOrThrow({where: {id: chat.leadId}});
    expect(lead.email).toBe('new.visitor@example.com');
    expect(lead.subscribed).toBe(false);
    expect(MessengerSessionService.verify(res.body.data.token)).toMatchObject({
      contactId: chat.leadId,
      visitorId: chat.visitor,
      verified: false,
    });
  });

  it('subscribes the lead only when the visitor ticked the box', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);

    await captureEmail(chat.token, {email: 'opted-in@example.com', conversationId: chat.conversationId, subscribe: true});

    const lead = await prisma.contact.findUniqueOrThrow({where: {id: chat.leadId}});
    expect(lead.subscribed).toBe(true);
    expect(await prisma.event.count({where: {contactId: lead.id, name: 'contact.subscribed'}})).toBe(1);
  });

  it('moves the lead onto an existing contact and keeps that contact as it was', async () => {
    const {project} = await messengerProject();
    const existing = await factories.createContact({projectId: project.id, email: 'customer@example.com', subscribed: false});
    const tag = await prisma.tag.create({data: {projectId: project.id, name: 'VIP', nameNorm: 'vip'}});
    await prisma.contactTag.create({data: {contactId: existing.id, tagId: tag.id}});
    await EventService.trackEvent(project.id, 'purchase.completed', existing.id);
    const chat = await visitorWithConversation(project.public);
    await EventService.trackEvent(project.id, 'page.viewed', chat.leadId);

    const res = await captureEmail(chat.token, {email: 'Customer@example.com', conversationId: chat.conversationId});

    expect(res.status).toBe(200);
    expect(await prisma.contact.findUnique({where: {id: chat.leadId}})).toBeNull();
    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversationId}});
    expect(conversation.contactId).toBe(existing.id);
    const identity = await prisma.contactIdentity.findUniqueOrThrow({
      where: {
        projectId_type_value: {projectId: project.id, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: chat.visitor},
      },
    });
    expect(identity.contactId).toBe(existing.id);

    const after = await prisma.contact.findUniqueOrThrow({where: {id: existing.id}, include: {contactTags: true}});
    expect(after.subscribed).toBe(false);
    expect(after.email).toBe('customer@example.com');
    expect(after.contactTags.map(row => row.tagId)).toEqual([tag.id]);
    const names = (await prisma.event.findMany({where: {contactId: existing.id}})).map(event => event.name);
    expect(names).toEqual(expect.arrayContaining(['purchase.completed', 'page.viewed', EMAIL_CAPTURED_EVENT]));
    expect(MessengerSessionService.verify(res.body.data.token)).toMatchObject({contactId: existing.id, verified: false});
  });

  it('subscribes an existing contact only when the visitor ticked the box', async () => {
    const {project} = await messengerProject();
    const existing = await factories.createContact({projectId: project.id, email: 'later@example.com', subscribed: false});
    const chat = await visitorWithConversation(project.public);

    await captureEmail(chat.token, {email: 'later@example.com', conversationId: chat.conversationId, subscribe: true});

    expect((await prisma.contact.findUniqueOrThrow({where: {id: existing.id}})).subscribed).toBe(true);
  });

  it('never unsubscribes an existing contact', async () => {
    const {project} = await messengerProject();
    const existing = await factories.createContact({projectId: project.id, email: 'fan@example.com', subscribed: true});
    const chat = await visitorWithConversation(project.public);

    await captureEmail(chat.token, {email: 'fan@example.com', conversationId: chat.conversationId});

    expect((await prisma.contact.findUniqueOrThrow({where: {id: existing.id}})).subscribed).toBe(true);
  });

  it("keeps the visitor out of the existing contact's other conversations after the move", async () => {
    const {project} = await messengerProject();
    const existing = await factories.createContact({projectId: project.id, email: 'owner@example.com'});
    const privateThread = await prisma.conversation.create({
      data: {projectId: project.id, contactId: existing.id, channel: 'WIDGET', originVisitorId: visitorId()},
    });
    const chat = await visitorWithConversation(project.public);

    const res = await captureEmail(chat.token, {email: 'owner@example.com', conversationId: chat.conversationId});
    const token = res.body.data.token as string;

    const list = await request(app).get('/v1/messenger/conversations').set('Authorization', `Bearer ${token}`);
    expect(list.body.data.map((c: {id: string}) => c.id)).toEqual([chat.conversationId]);
    const read = await request(app)
      .get(`/v1/messenger/conversations/${privateThread.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(read.status).toBe(404);
    const reply = await request(app)
      .post(`/v1/messenger/conversations/${privateThread.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({body: 'Let me in'});
    expect(reply.status).toBe(404);
  });

  it('emits chat.email_captured with the conversation id, once per capture', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);

    await captureEmail(chat.token, {email: 'events@example.com', conversationId: chat.conversationId});
    await captureEmail(chat.token, {email: 'events@example.com', conversationId: chat.conversationId});

    const events = await capturedEvents(chat.leadId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({conversationId: chat.conversationId});
    expect(EventService.isReservedEvent(EMAIL_CAPTURED_EVENT)).toBe(true);
  });

  it('refuses a second, different address for the same visitor', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);
    await captureEmail(chat.token, {email: 'first@example.com', conversationId: chat.conversationId});

    const res = await captureEmail(chat.token, {email: 'second@example.com', conversationId: chat.conversationId});

    expect(res.status).toBe(409);
    expect((await prisma.contact.findUniqueOrThrow({where: {id: chat.leadId}})).email).toBe('first@example.com');
  });

  it('keeps conversation email reachable for a chat contact who did not opt in', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);
    await captureEmail(chat.token, {email: 'no-news@example.com', conversationId: chat.conversationId});

    const lead = await prisma.contact.findUniqueOrThrow({where: {id: chat.leadId}});
    expect(lead.subscribed).toBe(false);
    expect(isTransactionallyMailableContact(lead)).toBe(true);
  });

  it('refuses a capture once the contact has been anonymized', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);
    await ContactService.delete(project.id, chat.leadId);

    const res = await captureEmail(chat.token, {email: 'ghost@example.com', conversationId: chat.conversationId});

    expect(res.status).toBe(404);
    expect((await prisma.contact.findUniqueOrThrow({where: {id: chat.leadId}})).email).toBeNull();
  });

  it('refuses to fold a lead that carries an external id or tags into another contact', async () => {
    const {project} = await messengerProject();
    await factories.createContact({projectId: project.id, email: 'taken@example.com'});
    const tag = await prisma.tag.create({data: {projectId: project.id, name: 'Trial', nameNorm: 'trial'}});

    const tagged = await visitorWithConversation(project.public);
    await prisma.contactTag.create({data: {contactId: tagged.leadId, tagId: tag.id}});
    const identified = await visitorWithConversation(project.public);
    await prisma.contact.update({where: {id: identified.leadId}, data: {externalId: 'user-42'}});

    for (const chat of [tagged, identified]) {
      const res = await captureEmail(chat.token, {email: 'taken@example.com', conversationId: chat.conversationId});
      expect(res.status).toBe(409);
      expect(await prisma.contact.findUnique({where: {id: chat.leadId}})).not.toBeNull();
      expect((await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversationId}})).contactId).toBe(chat.leadId);
    }
  });

  it("only takes an email for the visitor's own conversation, and validates it", async () => {
    const {project} = await messengerProject();
    const mine = await visitorWithConversation(project.public);
    const theirs = await visitorWithConversation(project.public);

    expect((await captureEmail(mine.token, {email: 'x@example.com', conversationId: theirs.conversationId})).status).toBe(404);
    expect((await captureEmail(mine.token, {email: 'not-an-email', conversationId: mine.conversationId})).status).toBe(422);
    const anonymous = await request(app).post('/v1/messenger/email').send({email: 'x@example.com'});
    expect(anonymous.status).toBe(401);
  });

  it('tells a returning visitor whether they already gave an email, without the address', async () => {
    const {project} = await messengerProject();
    const chat = await visitorWithConversation(project.public);
    const bootAgain = () => boot(project.public, {visitorId: chat.visitor, parentOrigin: ALLOWED}, API_ORIGIN);

    expect((await bootAgain()).body.data.visitor).toEqual({hasEmail: false});
    await captureEmail(chat.token, {email: 'returning@example.com', conversationId: chat.conversationId});
    const res = await bootAgain();
    expect(res.body.data.visitor).toEqual({hasEmail: true});
    expect(JSON.stringify(res.body)).not.toContain('returning@example.com');
  });

  it('settles racing first messages on one lead when the identity points at an anonymized contact', async () => {
    const {project} = await messengerProject();
    const visitor = visitorId();
    const erased = await factories.createContact({projectId: project.id, email: null, deletedAt: new Date()});
    await prisma.contactIdentity.create({
      data: {projectId: project.id, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: visitor, contactId: erased.id},
    });
    const leadsBefore = await prisma.contact.count({where: {projectId: project.id}});
    const sessionFor = {projectId: project.id, visitorId: visitor, contactId: null, verified: false};

    const resolved = await Promise.all(
      Array.from({length: 5}, () => MessengerContactService.resolveVisitorContact(sessionFor)),
    );

    expect(new Set(resolved).size).toBe(1);
    expect(await prisma.contact.count({where: {projectId: project.id}})).toBe(leadsBefore + 1);
  });
});
