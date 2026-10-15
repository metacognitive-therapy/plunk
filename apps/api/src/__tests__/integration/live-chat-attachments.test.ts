import {ListObjectsV2Command, S3Client} from '@aws-sdk/client-s3';
import {Role} from '@plunk/db';
import request from 'supertest';
import {beforeAll, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {
  S3_ACCESS_KEY_ID,
  S3_ACCESS_KEY_SECRET,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  S3_PRIVATE_BUCKET,
} from '../../app/constants';
import {ChatAttachments} from '../../controllers/ChatAttachments';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {ATTACHMENT_LINK_TTL_SECONDS, ChatAttachmentService} from '../../services/ChatAttachmentService';
import * as S3Service from '../../services/S3Service';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

const app = buildHttpApp({controllers: [new Messenger(), new Conversations(), new ChatAttachments()]});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: S3_ENDPOINT,
  credentials: {accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_ACCESS_KEY_SECRET},
  forcePathStyle: S3_FORCE_PATH_STYLE,
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b80000000049454e44ae426082', 'hex'),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

async function chat() {
  const {owner, project} = await messengerProject();
  const visitor = await session(project.public);
  const started = await startConversation(visitor.token);
  return {owner, project, token: started.token, conversationId: started.conversation.id};
}

function visitorUpload(token: string, conversationId: string, file: Buffer, filename: string, body?: string) {
  const req = request(app)
    .post(`/v1/messenger/conversations/${conversationId}/attachments`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', file, filename);
  return body === undefined ? req : req.field('body', body);
}

function agentUpload(agent: {id: string}, projectId: string, conversationId: string, file: Buffer, filename: string) {
  return request(app)
    .post(`/conversations/${conversationId}/attachments`)
    .set(asAgent(agent.id, projectId))
    .attach('file', file, filename);
}

function download(url: string) {
  const parsed = new URL(url);
  return request(app)
    .get(parsed.pathname + parsed.search)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

async function storedKeys(projectId: string, conversationId: string): Promise<string[]> {
  const listed = await s3.send(
    new ListObjectsV2Command({Bucket: S3_PRIVATE_BUCKET, Prefix: `${projectId}/${conversationId}/`}),
  );
  return (listed.Contents ?? []).map(object => object.Key!);
}

beforeAll(async () => {
  await S3Service.initializePrivateBucket();
});

describe('Chat attachments', () => {
  it('lets the visitor and the agent each send an image and a PDF that both sides see', async () => {
    const {owner, project, token, conversationId} = await chat();

    const image = await visitorUpload(token, conversationId, PNG, 'screenshot.png', 'Here is the error');
    expect(image.status, JSON.stringify(image.body)).toBe(201);
    expect(image.body.data).toMatchObject({
      body: 'Here is the error',
      attachments: [{filename: 'screenshot.png', contentType: 'image/png', size: PNG.length}],
    });
    expect((await visitorUpload(token, conversationId, PDF, 'invoice.pdf')).status).toBe(201);
    expect((await agentUpload(owner, project.id, conversationId, PNG, 'steps.png')).status).toBe(201);
    expect((await agentUpload(owner, project.id, conversationId, PDF, 'guide.pdf')).status).toBe(201);

    const names = (messages: {attachments: {filename: string}[]}[]) =>
      messages.flatMap(message => message.attachments.map(attachment => attachment.filename));
    const inbox = await request(app).get(`/conversations/${conversationId}`).set(asAgent(owner.id, project.id));
    expect(names(inbox.body.data.messages)).toEqual(['screenshot.png', 'invoice.pdf', 'steps.png', 'guide.pdf']);
    const messenger = await request(app)
      .get(`/v1/messenger/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(names(messenger.body.data.messages)).toEqual(['screenshot.png', 'invoice.pdf', 'steps.png', 'guide.pdf']);

    const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: conversationId}});
    expect(conversation.lastMessagePreview).toBe('📎 guide.pdf');
  });

  it('serves a file only through a signed link that expires', async () => {
    const {owner, project, token, conversationId} = await chat();
    const sent = await visitorUpload(token, conversationId, PDF, 'invoice.pdf');
    const attachmentId = sent.body.data.attachments[0].id;
    const attachment = await prisma.conversationAttachment.findUniqueOrThrow({where: {id: attachmentId}});

    const direct = await fetch(`${S3_ENDPOINT}/${S3_PRIVATE_BUCKET}/${attachment.key}`);
    expect(direct.status).toBe(403);

    const link = await request(app)
      .get(`/conversations/${conversationId}/attachments/${attachmentId}`)
      .set(asAgent(owner.id, project.id));
    expect(link.status).toBe(200);
    const served = await download(link.body.data.url);
    expect(served.status).toBe(200);
    expect(Buffer.compare(served.body as Buffer, PDF)).toBe(0);
    expect(served.headers['content-type']).toBe('application/pdf');
    expect(served.headers['content-disposition']).toContain('attachment; filename="invoice.pdf"');
    expect(served.headers['x-content-type-options']).toBe('nosniff');

    const expired = ChatAttachmentService.link(attachmentId, Date.now() - (ATTACHMENT_LINK_TTL_SECONDS + 1) * 1000);
    expect((await download(expired.url)).status).toBe(403);

    const tampered = new URL(link.body.data.url);
    tampered.searchParams.set('expires', String(Number(tampered.searchParams.get('expires')) + 60));
    expect((await download(tampered.toString())).status).toBe(403);
  });

  it('shows images inline for the visitor too', async () => {
    const {owner, project, token, conversationId} = await chat();
    const sent = await agentUpload(owner, project.id, conversationId, PNG, 'steps.png');
    const link = await request(app)
      .get(`/v1/messenger/conversations/${conversationId}/attachments/${sent.body.data.attachments[0].id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(link.status).toBe(200);

    const served = await download(link.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-disposition']).toMatch(/^inline;/);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('never issues a link to another visitor, a non-agent member or another project', async () => {
    const {project, token, conversationId} = await chat();
    const sent = await visitorUpload(token, conversationId, PDF, 'invoice.pdf');
    const attachmentId = sent.body.data.attachments[0].id;

    const stranger = await session(project.public);
    const strangerConversation = await startConversation(stranger.token);
    for (const target of [conversationId, strangerConversation.conversation.id]) {
      const res = await request(app)
        .get(`/v1/messenger/conversations/${target}/attachments/${attachmentId}`)
        .set('Authorization', `Bearer ${strangerConversation.token}`);
      expect(res.status).toBe(404);
    }

    const member = await factories.createUser();
    await prisma.user.update({where: {id: member.id}, data: {emailVerified: true}});
    await prisma.membership.create({data: {userId: member.id, projectId: project.id, role: Role.MEMBER}});
    const memberRes = await request(app)
      .get(`/conversations/${conversationId}/attachments/${attachmentId}`)
      .set(asAgent(member.id, project.id));
    expect(memberRes.status).toBe(403);

    const other = await chat();
    const otherRes = await request(app)
      .get(`/conversations/${conversationId}/attachments/${attachmentId}`)
      .set(asAgent(other.owner.id, other.project.id));
    expect(otherRes.status).toBe(404);
  });

  it('refuses oversized, disallowed and disguised files before storing them', async () => {
    const {owner, project, token, conversationId} = await chat();

    const oversized = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await visitorUpload(token, conversationId, oversized, 'big.pdf')).status).toBe(413);
    expect((await visitorUpload(token, conversationId, Buffer.from('<svg onload="x()"/>'), 'logo.svg')).status).toBe(415);
    expect((await visitorUpload(token, conversationId, Buffer.from('MZ\x90\x00'), 'setup.exe')).status).toBe(415);
    expect((await agentUpload(owner, project.id, conversationId, Buffer.from('not an image'), 'photo.png')).status).toBe(
      415,
    );
    expect((await visitorUpload(token, conversationId, Buffer.from('a\u0000b'), 'notes.txt')).status).toBe(415);

    expect(await prisma.conversationAttachment.count({where: {conversationId}})).toBe(0);
    expect(await storedKeys(project.id, conversationId)).toEqual([]);
  });

  it('requires a session before reading an upload', async () => {
    const {conversationId} = await chat();
    const res = await request(app).post(`/v1/messenger/conversations/${conversationId}/attachments`).attach('file', PDF, 'a.pdf');
    expect(res.status).toBe(401);
  });
});
