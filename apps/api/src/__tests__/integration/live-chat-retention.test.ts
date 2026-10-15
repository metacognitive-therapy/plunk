import {ListObjectsV2Command, S3Client} from '@aws-sdk/client-s3';
import request from 'supertest';
import {beforeAll, describe, expect, it} from 'vitest';

import {getPrismaClient} from '../../../../../test/helpers';
import {
  S3_ACCESS_KEY_ID,
  S3_ACCESS_KEY_SECRET,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  S3_PRIVATE_BUCKET,
} from '../../app/constants';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Projects} from '../../controllers/Projects';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {ChatRetentionService} from '../../services/ChatRetentionService';
import {ContactService} from '../../services/ContactService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import * as S3Service from '../../services/S3Service';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new Projects()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: S3_ENDPOINT,
  credentials: {accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_ACCESS_KEY_SECRET},
  forcePathStyle: S3_FORCE_PATH_STYLE,
});
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const DAY = 24 * 60 * 60 * 1000;

type Project = Awaited<ReturnType<typeof messengerProject>>;

async function objects(projectId: string, conversationId: string): Promise<string[]> {
  const listed = await s3.send(
    new ListObjectsV2Command({Bucket: S3_PRIVATE_BUCKET, Prefix: `${projectId}/${conversationId}/`}),
  );
  return (listed.Contents ?? []).map(object => object.Key!);
}

async function chatWithFiles(setup?: Project) {
  const {owner, project} = setup ?? (await messengerProject());
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  const conversationId = started.conversation.id;
  const upload = await request(app)
    .post(`/v1/messenger/conversations/${conversationId}/attachments`)
    .set('Authorization', `Bearer ${started.token}`)
    .attach('file', PDF, 'notes.pdf');
  expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  await S3Service.putPrivateObject(`${project.id}/${conversationId}/orphan`, Buffer.from('left behind'), 'text/plain');
  const {contactId} = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
  expect(await objects(project.id, conversationId)).toHaveLength(2);
  return {owner, project, visitor, token: started.token, conversationId, contactId};
}

async function expectErased(projectId: string, conversationId: string) {
  expect(await prisma.conversation.findUnique({where: {id: conversationId}})).toBeNull();
  expect(await prisma.conversationMessage.count({where: {conversationId}})).toBe(0);
  expect(await prisma.conversationAttachment.count({where: {conversationId}})).toBe(0);
  expect(await objects(projectId, conversationId)).toEqual([]);
}

async function close(owner: {id: string}, projectId: string, conversationId: string, daysAgo: number) {
  const res = await request(app)
    .post(`/conversations/${conversationId}/status`)
    .set(asAgent(owner.id, projectId))
    .send({status: 'CLOSED'});
  expect(res.status).toBe(200);
  await prisma.conversation.update({where: {id: conversationId}, data: {closedAt: new Date(Date.now() - daysAgo * DAY)}});
}

/* Backdates every trace of activity, so only the field a test leaves fresh decides the outcome. */
async function age(contactId: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * DAY);
  await prisma.$executeRaw`UPDATE "contacts" SET "createdAt" = ${at}, "updatedAt" = ${at} WHERE "id" = ${contactId}`;
  await prisma.$executeRaw`UPDATE "conversations" SET "createdAt" = ${at}, "lastMessageAt" = ${at} WHERE "contactId" = ${contactId}`;
  await prisma.$executeRaw`UPDATE "contact_identities" SET "lastSeenAt" = ${at} WHERE "contactId" = ${contactId}`;
  await prisma.$executeRaw`UPDATE "events" SET "createdAt" = ${at} WHERE "contactId" = ${contactId}`;
}

async function lead(project: Project['project'], daysAgo = 120) {
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  const {contactId} = await prisma.conversation.findUniqueOrThrow({where: {id: started.conversation.id}});
  await age(contactId, daysAgo);
  return {contactId, conversationId: started.conversation.id};
}

beforeAll(async () => {
  await S3Service.initializePrivateBucket();
});

describe('Erasing a contact', () => {
  it('deletes their conversations, messages, attachments and every object under them', async () => {
    const chat = await chatWithFiles();
    await ContactService.delete(chat.project.id, chat.contactId);

    await expectErased(chat.project.id, chat.conversationId);
    expect((await prisma.contact.findUniqueOrThrow({where: {id: chat.contactId}})).deletedAt).not.toBeNull();
  });

  it('erases by external id too', async () => {
    const chat = await chatWithFiles();
    await prisma.contact.update({where: {id: chat.contactId}, data: {externalId: `user-${chat.contactId}`}});
    await ContactService.anonymizeByExternalId(chat.project.id, `user-${chat.contactId}`);

    await expectErased(chat.project.id, chat.conversationId);
  });

  it('erases in bulk, and again on a repeat for contacts already anonymized', async () => {
    const first = await chatWithFiles();
    const second = await chatWithFiles({owner: first.owner, project: first.project});

    expect(await ContactService.bulkDelete(first.project.id, [first.contactId, second.contactId])).toEqual({
      deleted: 2,
      unchanged: 0,
    });
    await expectErased(first.project.id, first.conversationId);
    await expectErased(first.project.id, second.conversationId);

    const late = await prisma.conversation.create({
      data: {projectId: first.project.id, contactId: first.contactId, replyToken: `late-${first.contactId}`},
    });
    expect(await ContactService.bulkDelete(first.project.id, [first.contactId])).toEqual({deleted: 0, unchanged: 1});
    expect(await prisma.conversation.findUnique({where: {id: late.id}})).toBeNull();
  });

  it('leaves other contacts’ conversations alone', async () => {
    const erased = await chatWithFiles();
    const kept = await chatWithFiles({owner: erased.owner, project: erased.project});
    await ContactService.delete(erased.project.id, erased.contactId);

    expect(await prisma.conversation.findUnique({where: {id: kept.conversationId}})).not.toBeNull();
    expect(await objects(kept.project.id, kept.conversationId)).toHaveLength(2);
  });
});

describe('Retention sweep', () => {
  it('deletes closed conversations past each project’s own period, with their objects', async () => {
    const short = await messengerProject();
    await MessengerSettingsService.update(short.project.id, {retentionMonths: 1});
    const standard = await messengerProject();

    const expired = await chatWithFiles(short);
    await close(short.owner, short.project.id, expired.conversationId, 45);
    const recent = await chatWithFiles(short);
    await close(short.owner, short.project.id, recent.conversationId, 10);
    const open = await chatWithFiles(short);
    await prisma.conversation.update({where: {id: open.conversationId}, data: {lastMessageAt: new Date(Date.now() - 400 * DAY)}});
    const snoozed = await chatWithFiles(short);
    await prisma.conversation.update({
      where: {id: snoozed.conversationId},
      data: {status: 'SNOOZED', snoozedUntil: null, closedAt: new Date(Date.now() - 400 * DAY)},
    });
    const withinDefault = await chatWithFiles(standard);
    await close(standard.owner, standard.project.id, withinDefault.conversationId, 45);
    const pastDefault = await chatWithFiles(standard);
    await close(standard.owner, standard.project.id, pastDefault.conversationId, 25 * 31);

    await ChatRetentionService.sweep();

    await expectErased(short.project.id, expired.conversationId);
    await expectErased(standard.project.id, pastDefault.conversationId);
    for (const kept of [recent, open, snoozed]) {
      expect(await prisma.conversation.findUnique({where: {id: kept.conversationId}})).not.toBeNull();
      expect(await objects(short.project.id, kept.conversationId)).toHaveLength(2);
    }
    expect(await prisma.conversation.findUnique({where: {id: withinDefault.conversationId}})).not.toBeNull();
    expect(await prisma.contact.findUnique({where: {id: expired.contactId}})).not.toBeNull();
  });

  it('works through a backlog larger than one batch', async () => {
    const setup = await messengerProject();
    await MessengerSettingsService.update(setup.project.id, {retentionMonths: 1});
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const visitor = await session(setup.project.public);
      const started = await startConversation(visitor.token);
      await close(setup.owner, setup.project.id, started.conversation.id, 60 + i);
      ids.push(started.conversation.id);
    }

    const result = await ChatRetentionService.sweep({batchSize: 2});

    expect(result.conversations).toBeGreaterThanOrEqual(5);
    expect(await prisma.conversation.count({where: {id: {in: ids}}})).toBe(0);
  });
});

describe('Inactive messenger leads', () => {
  it('purges a lead with no email that has been quiet for 90 days, with all its conversations', async () => {
    const setup = await messengerProject();
    const {project} = setup;
    const quiet = await lead(project);
    const files = await chatWithFiles(setup);
    await age(files.contactId, 120);

    await ChatRetentionService.sweep();

    expect(await prisma.contact.findUnique({where: {id: quiet.contactId}})).toBeNull();
    expect(await prisma.conversation.findUnique({where: {id: quiet.conversationId}})).toBeNull();
    expect(await prisma.contact.findUnique({where: {id: files.contactId}})).toBeNull();
    await expectErased(project.id, files.conversationId);
  });

  it('keeps leads with an external id or an email, and leads active in the last 90 days', async () => {
    const {project} = await messengerProject();
    const identified = await lead(project);
    await prisma.$executeRaw`UPDATE "contacts" SET "externalId" = ${`ext-${identified.contactId}`} WHERE "id" = ${identified.contactId}`;
    const emailed = await lead(project);
    await prisma.$executeRaw`UPDATE "contacts" SET "email" = ${`${emailed.contactId}@example.com`} WHERE "id" = ${emailed.contactId}`;
    const recentMessage = await lead(project);
    await prisma.conversation.updateMany({where: {contactId: recentMessage.contactId}, data: {lastMessageAt: new Date()}});
    const recentEvent = await lead(project);
    await prisma.event.create({data: {projectId: project.id, contactId: recentEvent.contactId, name: 'page.viewed'}});
    const recentlySeen = await lead(project);
    await prisma.contactIdentity.updateMany({where: {contactId: recentlySeen.contactId}, data: {lastSeenAt: new Date()}});
    const recentlyUpdated = await lead(project);
    await prisma.contact.update({where: {id: recentlyUpdated.contactId}, data: {data: {plan: 'trial'}}});

    await ChatRetentionService.sweep();

    for (const kept of [identified, emailed, recentMessage, recentEvent, recentlySeen, recentlyUpdated]) {
      expect(await prisma.contact.findUnique({where: {id: kept.contactId}})).not.toBeNull();
      expect(await prisma.conversation.findUnique({where: {id: kept.conversationId}})).not.toBeNull();
    }
  });

  it('never purges an email-less contact the messenger didn’t create', async () => {
    const {project} = await messengerProject();
    const tracked = await prisma.contact.create({data: {projectId: project.id, email: null, subscribed: false}});
    await age(tracked.id, 400);

    await ChatRetentionService.sweep();

    expect(await prisma.contact.findUnique({where: {id: tracked.id}})).not.toBeNull();
  });
});

describe('PATCH /projects/:id/messenger retentionMonths', () => {
  it('saves a period between 1 and 120 months and refuses anything else', async () => {
    const {owner, project} = await messengerProject();
    const patch = (body: object) =>
      request(app).patch(`/projects/${project.id}/messenger`).set(asAgent(owner.id, project.id)).send(body);

    expect((await MessengerSettingsService.get(project.id)).retentionMonths).toBe(24);
    for (const retentionMonths of [0, 121, 1.5]) {
      expect((await patch({retentionMonths})).status).toBe(422);
    }
    const saved = await patch({retentionMonths: 6});
    expect(saved.status).toBe(200);
    expect(saved.body.data.retentionMonths).toBe(6);
  });
});

describe('Pending work for erased conversations', () => {
  it('does nothing for notification jobs whose message is gone', async () => {
    const chat = await chatWithFiles();
    const message = await prisma.conversationMessage.findFirstOrThrow({where: {conversationId: chat.conversationId}});
    await ContactService.delete(chat.project.id, chat.contactId);

    for (const type of ['mention', 'visitor_message', 'reply_email', 'agent_email', 'slack'] as const) {
      await expect(ChatNotificationService.process({type, messageId: message.id})).resolves.toBeDefined();
    }
  });
});
