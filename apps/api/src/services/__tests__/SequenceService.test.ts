import {SequenceStatus} from '@plunk/db';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ConflictError, NotFound} from '../../exceptions/index.js';
import {EmailService} from '../EmailService.js';
import {SequenceService} from '../SequenceService.js';
import {factories, getPrismaClient} from '../../../../../test/helpers';

describe('SequenceService', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  /**
   * The sweep's send primitive is EmailService.sendCampaignEmail; these tests
   * exercise the selection/claim logic around it, so the send itself is
   * replaced with a stub that still creates a real Email row (the claim
   * update holds an FK to it).
   */
  function stubSends() {
    return vi.spyOn(EmailService, 'sendCampaignEmail').mockImplementation(async params =>
      prisma.email.create({
        data: {
          projectId: params.projectId,
          contactId: params.contactId,
          subject: params.subject,
          body: params.body,
          from: params.from,
          sourceType: 'CAMPAIGN',
          sequenceId: params.sequenceId,
          sequenceStepId: params.sequenceStepId,
          sentAt: new Date(),
        },
      }),
    );
  }

  async function createActiveSequence(overrides: {from?: string} = {}) {
    const sequence = await SequenceService.create(projectId, {
      name: 'Newsletter',
      from: overrides.from ?? 'news@example.com',
    });
    await prisma.sequence.update({where: {id: sequence.id}, data: {status: SequenceStatus.ACTIVE}});
    return prisma.sequence.findUniqueOrThrow({where: {id: sequence.id}});
  }

  async function backdateEnrollment(sequenceId: string, contactId: string, minutes: number) {
    await prisma.sequenceSubscription.update({
      where: {sequenceId_contactId: {sequenceId, contactId}},
      data: {enrolledAt: new Date(Date.now() - minutes * 60_000)},
    });
  }

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.restoreAllMocks();
  });

  describe('steps', () => {
    it('appends steps in order and reorders with a full id list', async () => {
      const sequence = await createActiveSequence();
      const a = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      const b = await SequenceService.createStep(projectId, sequence.id, {subject: 'B', body: 'b', delayMinutes: 0});
      const c = await SequenceService.createStep(projectId, sequence.id, {subject: 'C', body: 'c', delayMinutes: 0});

      expect([a.order, b.order, c.order]).toEqual([1, 2, 3]);

      await SequenceService.reorderSteps(projectId, sequence.id, [c.id, a.id, b.id]);

      const steps = await prisma.sequenceStep.findMany({where: {sequenceId: sequence.id}, orderBy: {order: 'asc'}});
      expect(steps.map(s => s.subject)).toEqual(['C', 'A', 'B']);
    });

    it('rejects a reorder that does not cover every step exactly once', async () => {
      const sequence = await createActiveSequence();
      const a = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      await SequenceService.createStep(projectId, sequence.id, {subject: 'B', body: 'b', delayMinutes: 0});

      await expect(SequenceService.reorderSteps(projectId, sequence.id, [a.id])).rejects.toBeInstanceOf(ConflictError);
      await expect(SequenceService.reorderSteps(projectId, sequence.id, [a.id, a.id])).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('updateStep cannot flip published; publishStep is the only way', async () => {
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      expect(step.published).toBe(false);

      const updated = await SequenceService.updateStep(projectId, sequence.id, step.id, {subject: 'A2'});
      expect(updated.published).toBe(false);

      const published = await SequenceService.publishStep(projectId, sequence.id, step.id);
      expect(published.published).toBe(true);
    });
  });

  describe('activation', () => {
    it('requires a sender address before a sequence can become ACTIVE', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'No sender'});

      await expect(
        SequenceService.update(projectId, sequence.id, {status: SequenceStatus.ACTIVE}),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('requires the sender domain to be verified', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Unverified', from: 'a@unverified.com'});

      await expect(SequenceService.update(projectId, sequence.id, {status: SequenceStatus.ACTIVE})).rejects.toThrow();

      await factories.createDomain({projectId, domain: 'unverified.com', verified: true});
      const activated = await SequenceService.update(projectId, sequence.id, {status: SequenceStatus.ACTIVE});
      expect(activated.status).toBe(SequenceStatus.ACTIVE);
    });
  });

  describe('enrollment', () => {
    it('is idempotent for a single contact', async () => {
      const sequence = await createActiveSequence();
      const contact = await factories.createContact({projectId});

      const first = await SequenceService.enroll(projectId, sequence.id, contact.id);
      const second = await SequenceService.enroll(projectId, sequence.id, contact.id);

      expect(first).toEqual({enrolled: 1, skipped: 0});
      expect(second).toEqual({enrolled: 0, skipped: 1});
    });

    it('rejects enrollment into a DRAFT sequence but accepts it while PAUSED', async () => {
      const draft = await SequenceService.create(projectId, {name: 'Draft'});
      const contact = await factories.createContact({projectId});

      await expect(SequenceService.enroll(projectId, draft.id, contact.id)).rejects.toBeInstanceOf(ConflictError);

      // The controller calls enrollMany with an empty list purely to reach this
      // check before it queues a job, so the status guard has to win over the
      // empty-list short circuit.
      await expect(SequenceService.enrollMany(projectId, draft.id, [])).rejects.toBeInstanceOf(ConflictError);

      await prisma.sequence.update({where: {id: draft.id}, data: {status: SequenceStatus.PAUSED}});
      const outcome = await SequenceService.enroll(projectId, draft.id, contact.id);
      expect(outcome.enrolled).toBe(1);
    });

    it('rejects a contact from another project', async () => {
      const sequence = await createActiveSequence();
      const {project: otherProject} = await factories.createUserWithProject();
      const foreign = await factories.createContact({projectId: otherProject.id});

      await expect(SequenceService.enroll(projectId, sequence.id, foreign.id)).rejects.toBeInstanceOf(NotFound);
    });

    it('unenroll wipes the contact sent-set so re-enrollment restarts at step one', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);

      await SequenceService.unenroll(projectId, sequence.id, contact.id);
      expect(await prisma.sequenceStepSend.count({where: {sequenceId: sequence.id, contactId: contact.id}})).toBe(0);

      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(2); // Step one again, from scratch
    });
  });

  describe('deletion', () => {
    /**
     * Deleting a step is a routine edit, so it must not take already-sent mail
     * with it: the Email rows are the billing and contact-activity record.
     */
    it('deleting a step keeps the mail it already sent, only clearing the step attribution', async () => {
      stubSends();
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue();

      const email = await prisma.email.findFirstOrThrow({where: {sequenceStepId: step.id}});

      await SequenceService.deleteStep(projectId, sequence.id, step.id);

      const survivor = await prisma.email.findUnique({where: {id: email.id}});
      expect(survivor).not.toBeNull();
      expect(survivor?.sequenceStepId).toBeNull();
      expect(survivor?.sequenceId).toBe(sequence.id); // Stats aggregate here, so they stay right
      expect(await prisma.sequenceStepSend.count({where: {sequenceStepId: step.id}})).toBe(0);
    });

    it('deleting a sequence takes its steps, enrollments and send history with it', async () => {
      stubSends();
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'A', body: 'a', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue();

      await SequenceService.delete(projectId, sequence.id);

      expect(await prisma.sequenceStep.count({where: {sequenceId: sequence.id}})).toBe(0);
      expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id}})).toBe(0);
      expect(await prisma.sequenceStepSend.count({where: {sequenceId: sequence.id}})).toBe(0);
    });
  });

  describe('sweep selection', () => {
    it('sends the lowest-order published unsent step once its delay elapsed', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step1 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 0});
      const step2 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S2', body: 'b', delayMinutes: 60});
      await SequenceService.publishStep(projectId, sequence.id, step1.id);
      await SequenceService.publishStep(projectId, sequence.id, step2.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);

      // First sweep: step 1 (delay 0). Step 2 not due yet.
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);
      expect(sends.mock.calls[0]?.[0]).toMatchObject({sequenceStepId: step1.id, subject: 'S1'});

      // Second sweep immediately: nothing due.
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);

      // Backdate the step-1 send past step 2's delay: step 2 goes out.
      await prisma.sequenceStepSend.updateMany({
        where: {sequenceStepId: step1.id, contactId: contact.id},
        data: {sentAt: new Date(Date.now() - 61 * 60_000)},
      });
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(2);
      expect(sends.mock.calls[1]?.[0]).toMatchObject({sequenceStepId: step2.id});
    });

    it('anchors the first step delay on enrolledAt', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 30});
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);

      await SequenceService.sweepAllDue();
      expect(sends).not.toHaveBeenCalled();

      await backdateEnrollment(sequence.id, contact.id, 31);
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);
    });

    it('never sends draft steps, and a newly published step reaches caught-up contacts on the next sweep', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step1 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step1.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1); // Caught up

      // A draft step 2 exists but never sends.
      const step2 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S2', body: 'b', delayMinutes: 0});
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);

      // Published: the caught-up contact receives it on the very next sweep
      // (delay anchors on their previous send, not the publish date).
      await SequenceService.publishStep(projectId, sequence.id, step2.id);
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(2);
      expect(sends.mock.calls[1]?.[0]).toMatchObject({sequenceStepId: step2.id});
    });

    it('reordering after partial sends never double-sends or skips', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step1 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 0});
      const step2 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S2', body: 'b', delayMinutes: 0});
      const step3 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S3', body: 'b', delayMinutes: 0});
      for (const step of [step1, step2, step3]) {
        await SequenceService.publishStep(projectId, sequence.id, step.id);
      }

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue(); // Sends step 1
      expect(sends.mock.calls[0]?.[0]).toMatchObject({sequenceStepId: step1.id});

      // Move the already-sent step 1 to the end: the sent-set excludes it, so
      // the next send is step 2 (now lowest-order unsent) — no re-send of 1.
      await SequenceService.reorderSteps(projectId, sequence.id, [step2.id, step3.id, step1.id]);
      await SequenceService.sweepAllDue();
      await SequenceService.sweepAllDue();
      await SequenceService.sweepAllDue();

      const sentStepIds = sends.mock.calls.map(call => call[0]?.sequenceStepId);
      expect(sentStepIds).toEqual([step1.id, step2.id, step3.id]);
    });

    it('skips unsubscribed contacts without unenrolling them, and resumes when they re-subscribe', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contact = await factories.createContact({projectId, subscribed: false});
      await SequenceService.enroll(projectId, sequence.id, contact.id);

      await SequenceService.sweepAllDue();
      expect(sends).not.toHaveBeenCalled();
      expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id, contactId: contact.id}})).toBe(1);

      await prisma.contact.update({where: {id: contact.id}, data: {subscribed: true}});
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1);
    });

    it('skips PAUSED and DRAFT sequences entirely, preserving progress across a pause', async () => {
      const sends = stubSends();
      const sequence = await createActiveSequence();
      const step1 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S1', body: 'b', delayMinutes: 0});
      const step2 = await SequenceService.createStep(projectId, sequence.id, {subject: 'S2', body: 'b', delayMinutes: 0});
      await SequenceService.publishStep(projectId, sequence.id, step1.id);
      await SequenceService.publishStep(projectId, sequence.id, step2.id);

      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);
      await SequenceService.sweepAllDue(); // Step 1
      expect(sends).toHaveBeenCalledTimes(1);

      await prisma.sequence.update({where: {id: sequence.id}, data: {status: SequenceStatus.PAUSED}});
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(1); // Nothing while paused

      await prisma.sequence.update({where: {id: sequence.id}, data: {status: SequenceStatus.ACTIVE}});
      await SequenceService.sweepAllDue();
      expect(sends).toHaveBeenCalledTimes(2); // Resumes at step 2, progress intact
      expect(sends.mock.calls[1]?.[0]).toMatchObject({sequenceStepId: step2.id});
    });
  });
});
