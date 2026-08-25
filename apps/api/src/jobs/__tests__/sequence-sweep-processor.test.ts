import {SequenceStatus} from '@plunk/db';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailService} from '../../services/EmailService.js';
import {SequenceService} from '../../services/SequenceService.js';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * The sweep's correctness core: claim-then-send, P2002-skip under overlapping
 * runs, stale-claim reaping, claim release on send failure, and the per-run
 * send cap. Mirrors bulk-tag-processor.test.ts's convention of driving the
 * exported service logic directly rather than the BullMQ Worker.
 */
describe('sequence-sweep-processor', () => {
  let projectId: string;
  const prisma = getPrismaClient();

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

  async function createPublishedSequence(stepCount = 1) {
    const created = await SequenceService.create(projectId, {name: 'Sweep', from: 'news@example.com'});
    await prisma.sequence.update({where: {id: created.id}, data: {status: SequenceStatus.ACTIVE}});

    for (let i = 0; i < stepCount; i += 1) {
      const step = await SequenceService.createStep(projectId, created.id, {
        subject: `S${i + 1}`,
        body: 'body',
        delayMinutes: 0,
      });
      await SequenceService.publishStep(projectId, created.id, step.id);
    }

    return prisma.sequence.findUniqueOrThrow({
      where: {id: created.id},
      include: {steps: {where: {published: true}, orderBy: {order: 'asc'}}},
    });
  }

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.restoreAllMocks();
  });

  it('sends each due contact exactly once across more contacts than one batch page', async () => {
    const sends = stubSends();
    const sequence = await createPublishedSequence();

    const contacts = await factories.createContacts(projectId, 12);
    await SequenceService.enrollMany(
      projectId,
      sequence.id,
      contacts.map(contact => contact.id),
    );

    await SequenceService.sweepAllDue();

    expect(sends).toHaveBeenCalledTimes(12);
    const sendRows = await prisma.sequenceStepSend.findMany({where: {sequenceId: sequence.id}});
    expect(sendRows).toHaveLength(12);
    expect(sendRows.every(row => row.emailId && row.sentAt)).toBe(true);
  });

  it('two concurrent sweeps still send exactly once per contact (P2002 claim race)', async () => {
    const sends = stubSends();
    const sequence = await createPublishedSequence();

    const contacts = await factories.createContacts(projectId, 5);
    await SequenceService.enrollMany(
      projectId,
      sequence.id,
      contacts.map(contact => contact.id),
    );

    await Promise.all([SequenceService.sweepAllDue(), SequenceService.sweepAllDue()]);

    expect(sends).toHaveBeenCalledTimes(5);
    expect(await prisma.sequenceStepSend.count({where: {sequenceId: sequence.id}})).toBe(5);
  });

  it('releases the claim when the send fails so the next sweep retries', async () => {
    const sends = vi.spyOn(EmailService, 'sendCampaignEmail').mockRejectedValueOnce(new Error('SES down'));
    const sequence = await createPublishedSequence();

    const contact = await factories.createContact({projectId});
    await SequenceService.enroll(projectId, sequence.id, contact.id);

    const failed = await SequenceService.sweepAllDue();
    expect(failed.failed).toBe(1);
    expect(await prisma.sequenceStepSend.count({where: {sequenceId: sequence.id}})).toBe(0);

    sends.mockRestore();
    stubSends();
    const retried = await SequenceService.sweepAllDue();
    expect(retried.sent).toBe(1);
  });

  it('reaps stale claims left by a crash between claim and send', async () => {
    const sequence = await createPublishedSequence();
    const contact = await factories.createContact({projectId});
    await SequenceService.enroll(projectId, sequence.id, contact.id);

    // A claim with no email, older than the reap window
    const step = sequence.steps[0]!;
    await prisma.sequenceStepSend.create({
      data: {
        sequenceId: sequence.id,
        sequenceStepId: step.id,
        contactId: contact.id,
        createdAt: new Date(Date.now() - 31 * 60_000),
      },
    });

    const reaped = await SequenceService.reapStaleClaims();
    expect(reaped).toBe(1);

    // With the claim released, the step sends on the next sweep
    const sends = stubSends();
    await SequenceService.sweepAllDue();
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('leaves fresh claims alone when reaping', async () => {
    const sequence = await createPublishedSequence();
    const contact = await factories.createContact({projectId});
    await SequenceService.enroll(projectId, sequence.id, contact.id);

    await prisma.sequenceStepSend.create({
      data: {sequenceId: sequence.id, sequenceStepId: sequence.steps[0]!.id, contactId: contact.id},
    });

    expect(await SequenceService.reapStaleClaims()).toBe(0);
  });

  it('stops at the per-run send cap and resumes on the next run', async () => {
    const sends = stubSends();
    const sequence = await createPublishedSequence();

    const contacts = await factories.createContacts(projectId, 6);
    await SequenceService.enrollMany(
      projectId,
      sequence.id,
      contacts.map(contact => contact.id),
    );

    const capped = await SequenceService.sweepAllDue(2);
    expect(capped.sent).toBe(2);
    expect(capped.capped).toBe(true);

    const rest = await SequenceService.sweepAllDue();
    expect(rest.sent).toBe(4);
    expect(sends).toHaveBeenCalledTimes(6);
  });
});
