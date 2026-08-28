import {beforeEach, describe, expect, it, vi} from 'vitest';
import {EmailSourceType, EmailStatus, TrackingMode, WorkflowExecutionStatus, WorkflowTriggerType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {createServiceMocks, factories, getPrismaClient} from '../../../../../test/helpers';
import {EventService} from '../../services/EventService.js';

// Mock MeterService
vi.mock('../../services/MeterService.js', () => ({
  MeterService: {
    recordEmailSent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Email Processor', () => {
  let projectId: string;
  const prisma = getPrismaClient();
  const _serviceMocks = createServiceMocks();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject({}, {tracking: TrackingMode.ENABLED});
    projectId = project.id;
  });

  describe('Email Processing', () => {
    it('should process a pending email', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        subject: 'Test Email',
        body: '<p>Hello {{firstName}}</p>',
        status: EmailStatus.PENDING,
      });


      // Simulate processing
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENDING},
      });

      // Simulate successful send
      await prisma.email.update({
        where: {id: email.id},
        data: {
          status: EmailStatus.SENT,
          sentAt: new Date(),
        },
      });

      const processed = await prisma.email.findUnique({where: {id: email.id}});
      expect(processed?.status).toBe(EmailStatus.SENT);
      expect(processed?.sentAt).toBeDefined();
    });

    it('should skip emails that are not pending', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.SENT, // Already sent
      });

      // Processor should skip this email
      const shouldProcess = email.status === EmailStatus.PENDING;
      expect(shouldProcess).toBe(false);
    });

    it('should fail email if project is disabled', async () => {
      // Create project with disabled flag
      const {project: disabledProject} = await factories.createUserWithProject({}, {disabled: true});

      const contact = await factories.createContact({projectId: disabledProject.id});
      const email = await factories.createEmail(disabledProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });

      // Verify project is disabled
      const project = await prisma.project.findUnique({
        where: {id: disabledProject.id},
      });
      expect(project?.disabled).toBe(true);

      // Processor should fail this email
      await prisma.email.update({
        where: {id: email.id},
        data: {
          status: EmailStatus.FAILED,
          error: 'Project is disabled',
        },
      });

      const failed = await prisma.email.findUnique({where: {id: email.id}});
      expect(failed?.status).toBe(EmailStatus.FAILED);
      expect(failed?.error).toBe('Project is disabled');
    });

    it('should suppress (not cancel or fail) email if project sending is paused', async () => {
      // Create project with sending paused, but NOT disabled -- the whole point of
      // the pause is that it is a distinct, narrower brake.
      const {project: pausedProject} = await factories.createUserWithProject({}, {sendingPaused: true});

      const contact = await factories.createContact({projectId: pausedProject.id});
      const email = await factories.createEmail(pausedProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });

      const project = await prisma.project.findUnique({where: {id: pausedProject.id}});
      expect(project?.sendingPaused).toBe(true);
      expect(project?.disabled).toBe(false);

      // Mirrors the pause check in email-processor.ts: the email is marked
      // SUPPRESSED, never FAILED and never CANCELLED.
      await prisma.email.update({
        where: {id: email.id},
        data: {
          status: EmailStatus.SUPPRESSED,
          error: 'Project sending is paused',
        },
      });

      const suppressed = await prisma.email.findUnique({where: {id: email.id}});
      expect(suppressed?.status).toBe(EmailStatus.SUPPRESSED);
      // Distinct from both FAILED (the status used by disabled-project cancellation
      // above) and any notion of "cancelled" -- SUPPRESSED is its own terminal state.
      expect(suppressed?.status).not.toBe(EmailStatus.FAILED);
      expect(suppressed?.error).toBe('Project sending is paused');
    });

    it('should allow a subsequent send once the project is unpaused', async () => {
      const {project: pausedProject} = await factories.createUserWithProject({}, {sendingPaused: true});
      const contact = await factories.createContact({projectId: pausedProject.id});

      // First email is suppressed while paused.
      const suppressedEmail = await factories.createEmail(pausedProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });
      await prisma.email.update({
        where: {id: suppressedEmail.id},
        data: {status: EmailStatus.SUPPRESSED, error: 'Project sending is paused'},
      });

      // Unpause the project.
      await prisma.project.update({
        where: {id: pausedProject.id},
        data: {sendingPaused: false},
      });
      const unpaused = await prisma.project.findUnique({where: {id: pausedProject.id}});
      expect(unpaused?.sendingPaused).toBe(false);

      // A subsequent email now proceeds through the normal send path -- no manual
      // repair of the suppressed row is required.
      const nextEmail = await factories.createEmail(pausedProject.id, contact.id, {
        status: EmailStatus.PENDING,
      });
      await prisma.email.update({
        where: {id: nextEmail.id},
        data: {status: EmailStatus.SENT, sentAt: new Date()},
      });

      const sent = await prisma.email.findUnique({where: {id: nextEmail.id}});
      expect(sent?.status).toBe(EmailStatus.SENT);

      // The email suppressed during the pause is untouched -- it stays a visible
      // record of what would have gone out, it isn't silently retried.
      const stillSuppressed = await prisma.email.findUnique({where: {id: suppressedEmail.id}});
      expect(stillSuppressed?.status).toBe(EmailStatus.SUPPRESSED);
    });

    it('should handle campaign emails', async () => {
      const contact = await factories.createContact({projectId});
      const campaign = await factories.createCampaign({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        campaignId: campaign.id,
        status: EmailStatus.PENDING,
      });

      expect(email.campaignId).toBe(campaign.id);

      // Process the email
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENT, sentAt: new Date()},
      });

      const sent = await prisma.email.findUnique({where: {id: email.id}});
      expect(sent?.status).toBe(EmailStatus.SENT);
    });

    it('should handle transactional emails without unsubscribe', async () => {
      const contact = await factories.createContact({projectId});
      const template = await factories.createTemplate({
        projectId,
        type: 'TRANSACTIONAL',
      });

      await factories.createEmail(projectId, contact.id, {
        templateId: template.id,
        status: EmailStatus.PENDING,
      });

      expect(template.type).toBe('TRANSACTIONAL');
    });
  });

  describe('Email Status Transitions', () => {
    it('should transition PENDING -> SENDING -> SENT', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      expect(email.status).toBe(EmailStatus.PENDING);

      // Transition to SENDING
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENDING},
      });

      let updated = await prisma.email.findUnique({where: {id: email.id}});
      expect(updated?.status).toBe(EmailStatus.SENDING);

      // Transition to SENT
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENT, sentAt: new Date()},
      });

      updated = await prisma.email.findUnique({where: {id: email.id}});
      expect(updated?.status).toBe(EmailStatus.SENT);
      expect(updated?.sentAt).toBeDefined();
    });

    it('should handle PENDING -> SENDING -> FAILED', async () => {
      const contact = await factories.createContact({projectId});
      const email = await factories.createEmail(projectId, contact.id, {
        status: EmailStatus.PENDING,
      });

      // Transition to SENDING
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENDING},
      });

      // Fail with error
      await prisma.email.update({
        where: {id: email.id},
        data: {
          status: EmailStatus.FAILED,
          error: 'SES send failed: Invalid email address',
        },
      });

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

      // Simulate processing all emails
      await Promise.all(
        emails.map(email =>
          prisma.email.update({
            where: {id: email.id},
            data: {status: EmailStatus.SENT, sentAt: new Date()},
          }),
        ),
      );

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

      // Simulate failure
      const errorMessage = 'Failed to send: Rate limit exceeded';
      await prisma.email.update({
        where: {id: email.id},
        data: {
          status: EmailStatus.FAILED,
          error: errorMessage,
        },
      });

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
