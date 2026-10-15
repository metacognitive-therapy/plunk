import {randomUUID} from 'node:crypto';

import {EmailSourceType, EmailStatus} from '@plunk/db';
import request from 'supertest';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';
import {ChatAttachments} from '../../controllers/ChatAttachments';
import {Conversations} from '../../controllers/Conversations';
import {Messenger} from '../../controllers/Messenger';
import {Webhooks} from '../../controllers/Webhooks';
import {processEmailJob} from '../../jobs/email-processor';
import {BillingLimitService} from '../../services/BillingLimitService';
import {ChatNotificationService} from '../../services/ChatNotificationService';
import {MessengerSettingsService} from '../../services/MessengerSettingsService';
import {chatNotificationQueue} from '../../services/QueueService';
import * as S3Service from '../../services/S3Service';
import {SecurityService} from '../../services/SecurityService';
import {sendRawEmail} from '../../services/SESService';
import {REPLY_ABOVE_MARKER, stripQuotedReply} from '../../utils/replyText';
import {buildHttpApp} from '../helpers/httpApp';
import {asAgent, messengerClient, messengerProject} from '../helpers/messenger';

vi.mock('../../services/SESService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService.js')>()),
  sendRawEmail: vi.fn().mockImplementation(async () => ({messageId: `ses-${randomUUID()}`})),
}));

const app = buildHttpApp({
  controllers: [new Messenger(), new Conversations(), new Webhooks(), new ChatAttachments()],
});
const prisma = getPrismaClient();
const {session, startConversation} = messengerClient(app);

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

beforeAll(async () => {
  await S3Service.initializePrivateBucket();
});

beforeEach(() => {
  vi.spyOn(SecurityService, 'verifySnsSignature').mockResolvedValue(true);
  vi.mocked(sendRawEmail).mockClear();
});

/* The queue lives in the developer's Redis, so delayed reply emails left behind would wait there
for their dev worker. Only jobs for this worker's own messages are removed. */
afterEach(async () => {
  vi.restoreAllMocks();
  const jobs = (await chatNotificationQueue.getDelayed()).filter(job => job.data.type === 'reply_email');
  const ours = await prisma.conversationMessage.findMany({
    where: {id: {in: jobs.map(job => job.data.messageId)}},
    select: {id: true},
  });
  const ids = new Set(ours.map(message => message.id));
  await Promise.all(jobs.filter(job => ids.has(job.data.messageId)).map(job => job.remove()));
});

/** A project whose agent replies are emailed, with a visitor who has left an email address. */
async function emailedChat(options: {visitorEmail?: string} = {}) {
  const {owner, project} = await messengerProject();
  const domain = `${randomUUID().slice(0, 8)}.example.com`;
  await prisma.domain.create({data: {projectId: project.id, domain, verified: true}});
  await MessengerSettingsService.update(project.id, {
    replyDomain: `reply.${domain}`,
    replyFromEmail: `support@${domain}`,
  });

  const visitor = await session(project.public);
  const started = await startConversation(visitor.token, 'Do you run evening sessions?');
  const email = options.visitorEmail ?? `visitor-${randomUUID().slice(0, 8)}@example.org`;
  const captured = await request(app)
    .post('/v1/messenger/email')
    .set('Authorization', `Bearer ${started.token}`)
    .send({conversationId: started.conversation.id, email});
  expect(captured.status, JSON.stringify(captured.body)).toBe(200);

  const conversation = await prisma.conversation.findUniqueOrThrow({where: {id: started.conversation.id}});
  return {
    owner,
    project,
    domain,
    email,
    token: captured.body.data.token as string,
    conversationId: conversation.id,
    replyAddress: `reply+${conversation.replyToken}@reply.${domain}`,
  };
}

async function agentReply(chat: {owner: {id: string}; project: {id: string}; conversationId: string}, body: string) {
  const res = await request(app)
    .post(`/conversations/${chat.conversationId}/messages`)
    .set(asAgent(chat.owner.id, chat.project.id))
    .send({body});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

function messengerThread(token: string, conversationId: string) {
  return request(app).get(`/v1/messenger/conversations/${conversationId}`).set('Authorization', `Bearer ${token}`);
}

function mime(input: {from: string; to: string; text: string; attachments?: {filename: string; type: string; content: Buffer}[]}) {
  const boundary = `b-${randomUUID()}`;
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}\r\n`,
    ...(input.attachments ?? []).map(
      file =>
        `--${boundary}\r\nContent-Type: ${file.type}; name="${file.filename}"\r\nContent-Disposition: attachment; filename="${file.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.content.toString('base64')}\r\n`,
    ),
  ];
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    'Subject: Re: Your conversation',
    `Message-ID: <${randomUUID()}@mail.example.org>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function deliver(
  input: Parameters<typeof mime>[0],
  verdicts: {spf?: string; dkim?: string; dmarc?: string} = {spf: 'PASS', dkim: 'PASS', dmarc: 'PASS'},
) {
  const sender = /<([^>]+)>/.exec(input.from)?.[1] ?? input.from;
  const event = {
    notificationType: 'Received',
    mail: {
      source: sender,
      timestamp: new Date().toISOString(),
      messageId: randomUUID(),
      commonHeaders: {from: [input.from], subject: 'Re: Your conversation'},
    },
    receipt: {
      recipients: [input.to],
      action: {type: 'SNS', encoding: 'BASE64'},
      spfVerdict: {status: verdicts.spf ?? 'GRAY'},
      dkimVerdict: {status: verdicts.dkim ?? 'GRAY'},
      dmarcVerdict: {status: verdicts.dmarc ?? 'GRAY'},
    },
    content: Buffer.from(mime(input)).toString('base64'),
  };
  return request(app)
    .post('/webhooks/sns')
    .send({Type: 'Notification', Message: JSON.stringify(event)});
}

const GMAIL_QUOTE = (reply: string) =>
  `${reply}\n\nOn Wed, 15 Oct 2026 at 13:00, Live chat QA <support@example.com>\nwrote:\n\n> ${REPLY_ABOVE_MARKER}\n> Yes, every Tuesday.\n`;

describe('Emailing unread agent replies', () => {
  it('schedules the email after the project delay', async () => {
    const chat = await emailedChat();
    await MessengerSettingsService.update(chat.project.id, {emailDelayMinutes: 7});
    const messageId = await agentReply(chat, 'Yes, every Tuesday at 18:00.');

    const job = await chatNotificationQueue.getJob(`reply_email-${messageId}`);
    expect(job?.data).toEqual({type: 'reply_email', messageId});
    expect(job?.opts.delay).toBe(7 * 60_000);
    await job?.remove();
  });

  it('emails unread replies once, threaded, with a reply address for the conversation', async () => {
    const chat = await emailedChat();
    const first = await agentReply(chat, 'Yes, every Tuesday at 18:00.');
    const second = await agentReply(chat, 'Would you like me to book you in?');

    expect(await ChatNotificationService.process({type: 'reply_email', messageId: first})).toEqual({sent: 2});
    expect(await ChatNotificationService.process({type: 'reply_email', messageId: second})).toEqual({sent: 0});
    expect(await ChatNotificationService.process({type: 'reply_email', messageId: first})).toEqual({sent: 0});

    const emails = await prisma.email.findMany({where: {projectId: chat.project.id}});
    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email).toMatchObject({
      sourceType: EmailSourceType.TRANSACTIONAL,
      status: EmailStatus.PENDING,
      from: `support@${chat.domain}`,
      replyTo: chat.replyAddress,
    });
    expect(email!.headers).toEqual({
      'In-Reply-To': `<conversation-${chat.conversationId}@reply.${chat.domain}>`,
      References: `<conversation-${chat.conversationId}@reply.${chat.domain}>`,
    });
    expect(email!.body).toContain('Yes, every Tuesday at 18:00.');
    expect(email!.body).toContain('Would you like me to book you in?');
    expect(email!.body).toContain(REPLY_ABOVE_MARKER);

    const stamped = await prisma.conversationMessage.findMany({where: {id: {in: [first, second]}}});
    expect(stamped.every(message => message.emailedAt !== null)).toBe(true);

    await processEmailJob(createMockJob({emailId: email!.id}));
    const sent = vi.mocked(sendRawEmail).mock.calls[0]![0];
    expect(sent.reply).toBe(chat.replyAddress);
    expect(sent.headers).toMatchObject({'In-Reply-To': `<conversation-${chat.conversationId}@reply.${chat.domain}>`});
  });

  it('never emails a reply the visitor has already read', async () => {
    const chat = await emailedChat();
    const messageId = await agentReply(chat, 'Yes, every Tuesday at 18:00.');
    const read = await request(app)
      .post(`/v1/messenger/conversations/${chat.conversationId}/read`)
      .set('Authorization', `Bearer ${chat.token}`);
    expect(read.status).toBe(200);

    expect(await ChatNotificationService.process({type: 'reply_email', messageId})).toEqual({sent: 0});
    expect(await prisma.email.count({where: {projectId: chat.project.id}})).toBe(0);
  });

  it('does not email a visitor who never gave an address, or a project without a reply domain', async () => {
    const {owner, project} = await messengerProject();
    const visitor = await session(project.public);
    const started = await startConversation(visitor.token);
    const messageId = await agentReply({owner, project, conversationId: started.conversation.id}, 'Hello!');
    expect(await ChatNotificationService.process({type: 'reply_email', messageId})).toEqual({sent: 0});
    expect(await chatNotificationQueue.getJob(`reply_email-${messageId}`)).toBeUndefined();
  });

  it('links attachments through long-lived links that redirect to a fresh download', async () => {
    const chat = await emailedChat();
    const upload = await request(app)
      .post(`/conversations/${chat.conversationId}/attachments`)
      .set(asAgent(chat.owner.id, chat.project.id))
      .attach('file', PDF, 'evening-schedule.pdf');
    expect(upload.status).toBe(201);
    await ChatNotificationService.process({type: 'reply_email', messageId: upload.body.data.id});

    const email = await prisma.email.findFirstOrThrow({where: {projectId: chat.project.id}});
    expect(email.attachments).toBeNull();
    const href = /href="([^"]+\/email\?[^"]+)"/.exec(email.body)![1]!.replace(/&amp;/g, '&');
    const link = new URL(href);
    const redirect = await request(app).get(link.pathname + link.search);
    expect(redirect.status).toBe(302);
    const download = new URL(redirect.headers.location!);
    const file = await request(app).get(download.pathname + download.search);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');

    link.searchParams.set('signature', 'forged');
    expect((await request(app).get(link.pathname + link.search)).status).toBe(404);
  });

  it('holds the email while sending is paused, and the messenger still shows the reply', async () => {
    const chat = await emailedChat();
    await prisma.project.update({where: {id: chat.project.id}, data: {sendingPaused: true}});
    const messageId = await agentReply(chat, 'Yes, every Tuesday at 18:00.');
    await ChatNotificationService.process({type: 'reply_email', messageId});

    const email = await prisma.email.findFirstOrThrow({where: {projectId: chat.project.id}});
    const job = createMockJob({emailId: email.id});
    job.moveToDelayed = vi.fn().mockResolvedValue(undefined);
    await expect(processEmailJob(job, 'token')).rejects.toThrow();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).status).toBe(EmailStatus.PENDING);
    expect(sendRawEmail).not.toHaveBeenCalled();

    const thread = await messengerThread(chat.token, chat.conversationId);
    expect(thread.body.data.messages.map((message: {body: string}) => message.body)).toContain(
      'Yes, every Tuesday at 18:00.',
    );
  });
});

describe('Receiving email replies', () => {
  it('turns a reply from the contact into a visitor message without the quoted history, and reopens', async () => {
    const chat = await emailedChat();
    await agentReply(chat, 'Yes, every Tuesday.');
    await request(app)
      .post(`/conversations/${chat.conversationId}/status`)
      .set(asAgent(chat.owner.id, chat.project.id))
      .send({status: 'CLOSED'});

    const res = await deliver({
      from: `Ingrid <${chat.email.toUpperCase()}>`,
      to: chat.replyAddress,
      text: GMAIL_QUOTE('Great, please book me for next week.'),
      attachments: [{filename: 'referral.pdf', type: 'application/pdf', content: PDF}],
    });
    expect(res.status).toBe(200);

    const messages = await prisma.conversationMessage.findMany({
      where: {conversationId: chat.conversationId, authorType: 'CONTACT'},
      include: {attachments: true},
      orderBy: {createdAt: 'asc'},
    });
    const last = messages.at(-1)!;
    expect(last).toMatchObject({kind: 'COMMENT', source: 'EMAIL', body: 'Great, please book me for next week.'});
    expect(last.unverifiedSender).toBeNull();
    expect(last.attachments.map(file => file.filename)).toEqual(['referral.pdf']);
    expect((await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversationId}})).status).toBe('OPEN');

    const thread = await messengerThread(chat.token, chat.conversationId);
    expect(thread.body.data.messages.at(-1).body).toBe('Great, please book me for next week.');
  });

  it('turns a reply from anyone else into a flagged note the visitor never sees', async () => {
    const chat = await emailedChat();
    await agentReply(chat, 'Yes, every Tuesday.');
    const before = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversationId}});

    await deliver({from: 'Someone <forwarded@elsewhere.example>', to: chat.replyAddress, text: 'I got this forwarded.'});

    const note = await prisma.conversationMessage.findFirstOrThrow({
      where: {conversationId: chat.conversationId, source: 'EMAIL'},
    });
    expect(note).toMatchObject({kind: 'NOTE', unverifiedSender: 'forwarded@elsewhere.example', body: 'I got this forwarded.'});
    const after = await prisma.conversation.findUniqueOrThrow({where: {id: chat.conversationId}});
    expect(after.lastContactMessageAt).toEqual(before.lastContactMessageAt);

    const thread = await messengerThread(chat.token, chat.conversationId);
    expect(thread.body.data.messages.map((message: {body: string}) => message.body)).not.toContain(
      'I got this forwarded.',
    );
    const inbox = await request(app)
      .get(`/conversations/${chat.conversationId}`)
      .set(asAgent(chat.owner.id, chat.project.id));
    expect(inbox.body.data.messages.at(-1)).toMatchObject({kind: 'NOTE', unverifiedSender: 'forwarded@elsewhere.example'});
  });

  it("flags a reply that claims the contact's address but failed authentication", async () => {
    const chat = await emailedChat();
    await deliver(
      {from: chat.email, to: chat.replyAddress, text: 'Please send my records to this other address.'},
      {spf: 'FAIL', dkim: 'FAIL', dmarc: 'FAIL'},
    );
    const message = await prisma.conversationMessage.findFirstOrThrow({
      where: {conversationId: chat.conversationId, source: 'EMAIL'},
    });
    expect(message).toMatchObject({kind: 'NOTE', unverifiedSender: chat.email});
  });

  it('never fans a reply address out, creates a contact, or counts inbound usage', async () => {
    const chat = await emailedChat();
    /* Another project has verified the reply subdomain itself, so ordinary inbound mail to it would
    be delivered there. */
    const other = await factories.createUserWithProject();
    await prisma.domain.create({data: {projectId: other.project.id, domain: `reply.${chat.domain}`, verified: true}});
    const usage = vi.spyOn(BillingLimitService, 'incrementUsage');
    const contactsBefore = await prisma.contact.count({where: {projectId: {in: [chat.project.id, other.project.id]}}});

    await deliver({from: chat.email, to: chat.replyAddress, text: 'Thanks!'});
    await deliver({
      from: 'stranger@elsewhere.example',
      to: `reply+${randomUUID()}@reply.${chat.domain}`,
      text: 'Unknown token',
    });

    expect(usage).not.toHaveBeenCalledWith(expect.anything(), EmailSourceType.INBOUND);
    expect(await prisma.email.count({where: {projectId: {in: [chat.project.id, other.project.id]}, sourceType: 'INBOUND'}})).toBe(0);
    expect(await prisma.event.count({where: {projectId: other.project.id, name: 'email.received'}})).toBe(0);
    expect(await prisma.contact.count({where: {projectId: {in: [chat.project.id, other.project.id]}}})).toBe(contactsBefore);
    expect(await prisma.conversationMessage.count({where: {source: 'EMAIL', body: 'Unknown token'}})).toBe(0);
  });

  it('drops a reply sent to the token on a domain that is not the conversation’s reply domain', async () => {
    const chat = await emailedChat();
    const token = chat.replyAddress.split('@')[0];
    await deliver({from: chat.email, to: `${token}@reply.elsewhere.example`, text: 'Wrong door'});
    expect(await prisma.conversationMessage.count({where: {conversationId: chat.conversationId, source: 'EMAIL'}})).toBe(0);
  });

  it('keeps allowed attachments and lists refused ones', async () => {
    const chat = await emailedChat();
    await deliver({
      from: chat.email,
      to: chat.replyAddress,
      text: 'Two files',
      attachments: [
        {filename: 'notes.pdf', type: 'application/pdf', content: PDF},
        {filename: 'setup.exe', type: 'application/octet-stream', content: Buffer.from('MZ\x90\x00')},
      ],
    });
    const message = await prisma.conversationMessage.findFirstOrThrow({
      where: {conversationId: chat.conversationId, source: 'EMAIL'},
      include: {attachments: true},
    });
    expect(message.attachments.map(file => file.filename)).toEqual(['notes.pdf']);
    expect(message.body).toMatch(/^Two files\n\nNot attached: setup\.exe/);
  });
});

describe('Stripping quoted history', () => {
  it.each([
    ['Gmail', GMAIL_QUOTE('Sounds good')],
    ['Norwegian Gmail', 'Høres bra ut\n\nDen ons. 15. okt. 2026 kl. 13:00 skrev Kari Nordmann <\nkari@example.com>:\n\n> Hei'],
    ['Outlook', 'Sounds good\n\n________________________________\nFrom: Live chat QA <support@example.com>\nSent: Wednesday\n\nYes'],
    ['Norwegian Outlook', 'Sounds good\n\nFra: Live chat QA <support@example.com>\nSendt: onsdag 15. oktober 2026 13:00\nTil: meg'],
    ['our marker', `Sounds good\n${REPLY_ABOVE_MARKER}\nYes, every Tuesday.`],
    ['a signature', 'Sounds good\n-- \nKari Nordmann\nPsychologist'],
    ['a phone footer', 'Sounds good\n\nSendt fra min iPhone'],
  ])('cuts %s', (_name, text) => {
    expect(stripQuotedReply(text).startsWith('Sounds good') || stripQuotedReply(text) === 'Høres bra ut').toBe(true);
    expect(stripQuotedReply(text)).not.toMatch(/Yes|Hei|Kari|iPhone|From|Fra/);
  });
});
