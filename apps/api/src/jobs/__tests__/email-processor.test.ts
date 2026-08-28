import {beforeEach, describe, expect, it, vi} from 'vitest';
import {EmailSourceType, EmailStatus, TrackingMode, WorkflowExecutionStatus, WorkflowTriggerType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';
import {EventService} from '../../services/EventService.js';
import {sendRawEmail} from '../../services/SESService.js';
import {processEmailJob} from '../email-processor.js';

// Mock MeterService
vi.mock('../../services/MeterService.js', () => ({
  MeterService: {
    recordEmailSent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock SES so no real network call is attempted; processEmailJob is otherwise
// exercised for real (Prisma, EmailService, header/classification logic).
// `messageId` is unique-constrained on Email, and several tests (the batch test in
// particular) send more than one email per test, so each call must return a distinct id.
let mockMessageIdCounter = 0;
vi.mock('../../services/SESService.js', () => ({
  sendRawEmail: vi.fn().mockImplementation(async () => ({messageId: `mock-message-id-${mockMessageIdCounter++}`})),
  getSendingQuota: vi.fn().mockResolvedValue(null),
}));

describe('Email Processor', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject({}, {tracking: TrackingMode.ENABLED});
    projectId = project.id;
    vi.mocked(sendRawEmail).mockClear();
  });

  describe('Email Processing', () => {
    it('should process a pending email', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        subject: 'Test Email',
        body: '<p>Hello {{firstName}}</p>',
        status: EmailStatus.PENDING,
      });

      await processEmailJob(createMockJob({emailId: email.id}));

      const processed = await prisma.email.findUnique({where: {id: email.id}});
      expect(processed?.status).toBe(EmailStatus.SENT);
      expect(processed?.sentAt).toBeDefined();
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });

    it('should skip emails that are not pending', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.SENT, // Already sent
      });

      await processEmailJob(createMockJob({emailId: email.id}));

      expect(sendRawEmail).not.toHaveBeenCalled();
      const unchanged = await prisma.email.findUnique({where: {id: email.id}});
      expect(unchanged?.status).toBe(EmailStatus.SENT);
    });

    it('should fail email if project is disabled', async () => {
      // Create project with disabled flag
      const {project: disabledProject} = await factories.createUserWithProject({}, {disabled: true});

      const contact = await factories.createContact({projectId: disabledProject.id});
      const email = await factories.createEmail(disabledProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });

      await processEmailJob(createMockJob({emailId: email.id}));

      const failed = await prisma.email.findUnique({where: {id: email.id}});
      expect(failed?.status).toBe(EmailStatus.FAILED);
      expect(failed?.error).toBe('Project is disabled');
      expect(sendRawEmail).not.toHaveBeenCalled();
    });

    it('should hold (not suppress) a pending email and delay the job while sending is paused', async () => {
      // Create project with sending paused, but NOT disabled -- the whole point of
      // the pause is that it is a distinct, narrower brake.
      const {project: pausedProject} = await factories.createUserWithProject({}, {sendingPaused: true});

      const contact = await factories.createContact({projectId: pausedProject.id});
      const email = await factories.createEmail(pausedProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });

      const job = createMockJob({emailId: email.id});
      job.moveToDelayed = vi.fn().mockResolvedValue(undefined);

      // BullMQ's own pause primitive: the processor calls job.moveToDelayed then
      // throws DelayedError, which the Worker treats specially (not a failure, no
      // retry consumed). We only assert the primitive was invoked correctly and
      // that the email itself was left untouched -- Worker-level DelayedError
      // handling is BullMQ's own contract, not ours to re-test.
      await expect(processEmailJob(job, 'test-token')).rejects.toThrow();

      expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
      const [delayTimestamp, token] = vi.mocked(job.moveToDelayed).mock.calls[0]!;
      expect(delayTimestamp).toBeGreaterThan(Date.now());
      expect(token).toBe('test-token');

      // The email stays PENDING -- not SUPPRESSED, FAILED, or CANCELLED -- because
      // it will be delivered once the project is unpaused, not lost.
      const held = await prisma.email.findUnique({where: {id: email.id}});
      expect(held?.status).toBe(EmailStatus.PENDING);
      expect(held?.error).toBeNull();
      expect(sendRawEmail).not.toHaveBeenCalled();
    });

    it('should send held email once the project is unpaused', async () => {
      const {project: pausedProject} = await factories.createUserWithProject({}, {sendingPaused: true});
      const contact = await factories.createContact({projectId: pausedProject.id});

      const email = await factories.createEmail(pausedProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });

      const job = createMockJob({emailId: email.id});
      job.moveToDelayed = vi.fn().mockResolvedValue(undefined);
      await expect(processEmailJob(job)).rejects.toThrow();

      const stillHeld = await prisma.email.findUnique({where: {id: email.id}});
      expect(stillHeld?.status).toBe(EmailStatus.PENDING);

      // Unpause, then re-run the same job (BullMQ would redeliver it once the
      // delay elapses) -- no manual repair of the row is required.
      await prisma.project.update({where: {id: pausedProject.id}, data: {sendingPaused: false}});
      await processEmailJob(createMockJob({emailId: email.id}));

      const sent = await prisma.email.findUnique({where: {id: email.id}});
      expect(sent?.status).toBe(EmailStatus.SENT);
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });

    it('should handle campaign emails', async () => {
      const contact = await factories.createContact({projectId});
      const campaign = await factories.createCampaign({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        campaignId: campaign.id,
        status: EmailStatus.PENDING,
      });

      expect(email.campaignId).toBe(campaign.id);

      await processEmailJob(createMockJob({emailId: email.id}));

      const sent = await prisma.email.findUnique({where: {id: email.id}});
      expect(sent?.status).toBe(EmailStatus.SENT);
    });

    it('should handle transactional emails without unsubscribe', async () => {
      const contact = await factories.createContact({projectId});
      const template = await factories.createTemplate({
        projectId,
        type: 'TRANSACTIONAL',
      });

      const email = await factories.createEmail(projectId, contact.id, {
        templateId: template.id,
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.PENDING,
      });

      expect(template.type).toBe('TRANSACTIONAL');

      await processEmailJob(createMockJob({emailId: email.id}));

      const call = vi.mocked(sendRawEmail).mock.calls[0]![0];
      expect(call.content.html).not.toContain('unsubscribe');
    });
  });

  describe('Contact-safety gate immediately before the SES call', () => {
    it('suppresses (and does not send) a marketing email to a contact who unsubscribed after the job was queued', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      const campaign = await factories.createCampaign({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        campaignId: campaign.id,
        sourceType: EmailSourceType.CAMPAIGN,
        status: EmailStatus.PENDING,
      });

      // Unsubscribe happens after the job is queued but before it is processed.
      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: false}});

      await processEmailJob(createMockJob({emailId: email.id}));

      const result = await prisma.email.findUnique({where: {id: email.id}});
      expect(result?.status).toBe(EmailStatus.SUPPRESSED);
      expect(result?.error).toBeTruthy();
      expect(sendRawEmail).not.toHaveBeenCalled();
    });

    it('suppresses (and does not send) an email to a contact anonymized after the job was queued', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      // Anonymization happens after the job is queued but before it is processed:
      // email cleared and deletedAt stamped, mirroring ContactService's anonymize path.
      await prisma.contact.update({
        where: {id: contact.id},
        data: {email: null, deletedAt: new Date()},
      });

      await processEmailJob(createMockJob({emailId: email.id}));

      const result = await prisma.email.findUnique({where: {id: email.id}});
      expect(result?.status).toBe(EmailStatus.SUPPRESSED);
      expect(result?.error).toBeTruthy();
      expect(sendRawEmail).not.toHaveBeenCalled();
    });

    it('still sends a transactional email to a contact who unsubscribed (transactional is exempt from the subscription rule)', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      const email = await factories.createEmail(projectId, contact.id, {
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.PENDING,
      });

      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: false}});

      await processEmailJob(createMockJob({emailId: email.id}));

      const result = await prisma.email.findUnique({where: {id: email.id}});
      expect(result?.status).toBe(EmailStatus.SENT);
      expect(sendRawEmail).toHaveBeenCalledTimes(1);
    });

    it('does not send a transactional email to a contact anonymized after the job was queued', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.PENDING,
      });

      await prisma.contact.update({
        where: {id: contact.id},
        data: {email: null, deletedAt: new Date()},
      });

      await processEmailJob(createMockJob({emailId: email.id}));

      const result = await prisma.email.findUnique({where: {id: email.id}});
      expect(result?.status).toBe(EmailStatus.SUPPRESSED);
      expect(sendRawEmail).not.toHaveBeenCalled();
    });
  });

  describe('Email Status Transitions', () => {
    it('should transition PENDING -> SENDING -> SENT', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      expect(email.status).toBe(EmailStatus.PENDING);

      await processEmailJob(createMockJob({emailId: email.id}));

      const updated = await prisma.email.findUnique({where: {id: email.id}});
      expect(updated?.status).toBe(EmailStatus.SENT);
      expect(updated?.sentAt).toBeDefined();
    });

    it('should handle PENDING -> SENDING -> FAILED', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      vi.mocked(sendRawEmail).mockRejectedValueOnce(new Error('SES send failed: Invalid email address'));

      await expect(processEmailJob(createMockJob({emailId: email.id}))).rejects.toThrow('SES send failed');

      const failed = await prisma.email.findUnique({where: {id: email.id}});
      expect(failed?.status).toBe(EmailStatus.FAILED);
      expect(failed?.error).toContain('SES send failed');
    });
  });

  describe('Batch Processing', () => {
    it('should handle multiple emails from a campaign', async () => {
      const campaign = await factories.createCampaign({projectId});
      const contacts = await factories.createContacts(projectId, 10);

      // Create emails for all contacts
      const emails = await Promise.all(
        contacts.map(contact =>
          factories.createEmail(projectId, contact.id, {
            campaignId: campaign.id,
            status: EmailStatus.PENDING,
          }),
        ),
      );

      expect(emails).toHaveLength(10);
      expect(emails.every(e => e.campaignId === campaign.id)).toBe(true);

      await Promise.all(emails.map(email => processEmailJob(createMockJob({emailId: email.id}))));

      const processed = await prisma.email.findMany({
        where: {campaignId: campaign.id},
      });

      expect(processed.every(e => e.status === EmailStatus.SENT)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should record error message on failure', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      const errorMessage = 'Failed to send: Rate limit exceeded';
      vi.mocked(sendRawEmail).mockRejectedValueOnce(new Error(errorMessage));

      await expect(processEmailJob(createMockJob({emailId: email.id}))).rejects.toThrow(errorMessage);

      const failed = await prisma.email.findUnique({where: {id: email.id}});
      expect(failed?.status).toBe(EmailStatus.FAILED);
      expect(failed?.error).toBe(errorMessage);
    });
  });

  describe('Attachment Billing', () => {
    it('should verify emails with attachments have attachment data', async () => {
      const contact = await factories.createContact({projectId});

      // Create email with attachments
      const emailWithAttachments = await prisma.email.create({
        data: {
          projectId,
          contactId: contact.id,
          subject: 'Email with attachments',
          body: '<p>Test email with attachments</p>',
          from: 'test@example.com',
          status: EmailStatus.PENDING,
          sourceType: EmailSourceType.TRANSACTIONAL,
          attachments: toPrismaJson([
            {
              filename: 'document.pdf',
              content: 'base64encodedcontent',
              contentType: 'application/pdf',
            },
          ]),
        },
      });

      // Create email without attachments
      const emailWithoutAttachments = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      // Verify attachments are stored correctly
      const emailWithAttachmentsData = await prisma.email.findUnique({
        where: {id: emailWithAttachments.id},
      });
      const emailWithoutAttachmentsData = await prisma.email.findUnique({
        where: {id: emailWithoutAttachments.id},
      });

      expect(emailWithAttachmentsData?.attachments).toBeDefined();
      expect(Array.isArray(emailWithAttachmentsData?.attachments)).toBe(true);
      expect(
        Array.isArray(emailWithAttachmentsData?.attachments) ? emailWithAttachmentsData.attachments.length : 0,
      ).toBeGreaterThan(0);

      expect(emailWithoutAttachmentsData?.attachments).toBeNull();
    });

    it('should verify attachment logic determines charging correctly', async () => {
      const contact = await factories.createContact({projectId});

      // Create email with attachments
      const emailWithAttachments = await prisma.email.create({
        data: {
          projectId,
          contactId: contact.id,
          subject: 'Email with attachments',
          body: '<p>Test</p>',
          from: 'test@example.com',
          status: EmailStatus.PENDING,
          sourceType: EmailSourceType.TRANSACTIONAL,
          attachments: toPrismaJson([{filename: 'file.pdf', content: 'base64', contentType: 'application/pdf'}]),
        },
        include: {
          project: true,
          contact: true,
        },
      });

      // Simulate the logic from email-processor.ts
      const hasAttachments =
        emailWithAttachments.attachments &&
        Array.isArray(emailWithAttachments.attachments) &&
        emailWithAttachments.attachments.length > 0;
      const emailCount = hasAttachments ? 2 : 1;

      // Verify logic correctly identifies attachments
      expect(hasAttachments).toBe(true);
      expect(emailCount).toBe(2);

      // Test without attachments
      const emailWithoutAttachments = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });
      const emailWithoutAttachmentsData = await prisma.email.findUnique({
        where: {id: emailWithoutAttachments.id},
      });

      const hasNoAttachments =
        emailWithoutAttachmentsData?.attachments &&
        Array.isArray(emailWithoutAttachmentsData.attachments) &&
        emailWithoutAttachmentsData.attachments.length > 0;
      const emailCountNoAttachments = hasNoAttachments ? 2 : 1;

      expect(hasNoAttachments).toBeFalsy();
      expect(emailCountNoAttachments).toBe(1);
    });
  });

  describe('Sending pause does not affect ingestion or automation', () => {
    it('should still ingest events and progress workflows while sending is paused', async () => {
      // This is the behaviour that distinguishes a sending pause from a disabled
      // project: `disabled` is enforced in the auth middleware and blocks every
      // write, including event ingestion. `sendingPaused` is consulted ONLY by the
      // email processor, so everything else -- event ingestion, workflow triggers,
      // workflow step progression -- must keep working exactly as if the project
      // were not paused at all.
      const {project: pausedProject} = await factories.createUserWithProject({}, {sendingPaused: true});
      const contact = await factories.createContact({projectId: pausedProject.id});

      const workflow = await factories.createWorkflow({
        projectId: pausedProject.id,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'purchase.completed'},
      });

      const triggerStep = await prisma.workflowStep.findFirst({
        where: {workflowId: workflow.id, type: 'TRIGGER'},
      });
      const delayStep = await prisma.workflowStep.create({
        data: {
          workflowId: workflow.id,
          type: 'DELAY',
          name: 'Wait',
          position: {x: 100, y: 0},
          config: {amount: 24, unit: 'hours'},
        },
      });
      await prisma.workflowTransition.create({
        data: {fromStepId: triggerStep!.id, toStepId: delayStep.id},
      });

      // Real ingestion path -- not simulated -- on a project whose sending is paused.
      const event = await EventService.trackEvent(pausedProject.id, 'purchase.completed', contact.id, undefined, {
        amount: 99.99,
        product: 'Premium Plan',
      });

      // Event ingestion is unaffected by the pause.
      expect(event.contactId).toBe(contact.id);
      expect(event.name).toBe('purchase.completed');

      // The workflow was triggered and progressed to (or past) the DELAY step --
      // it was not skipped or blocked because the project is paused.
      const executions = await prisma.workflowExecution.findMany({
        where: {workflowId: workflow.id, contactId: contact.id},
      });
      expect(executions).toHaveLength(1);
      expect([WorkflowExecutionStatus.WAITING, WorkflowExecutionStatus.COMPLETED]).toContain(executions[0].status);
    });
  });
});
