import {SequenceStatus, TemplateType} from '@plunk/db';
import {MAX_DELAY_MINUTES, SequenceSchemas} from '@plunk/shared';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ConflictError, NotFound} from '../../exceptions/index.js';
import {EmailService} from '../../services/EmailService.js';
import {SequenceService} from '../../services/SequenceService.js';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Integration tests for the /sequences endpoints. Following this codebase's
 * convention (see tags.test.ts / campaigns.test.ts), these exercise the
 * request schemas plus the service layer the controllers call directly rather
 * than booting a live HTTP server.
 */
describe('Sequences API Integration Tests', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  async function activate(sequenceId: string) {
    await prisma.sequence.update({where: {id: sequenceId}, data: {status: SequenceStatus.ACTIVE}});
  }

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.restoreAllMocks();
  });

  describe('request validation', () => {
    it('rejects an empty sequence name on create', () => {
      expect(SequenceSchemas.create.safeParse({name: '   '}).success).toBe(false);
    });

    it('defaults the type to MARKETING', () => {
      const parsed = SequenceSchemas.create.parse({name: 'Newsletter'});
      expect(parsed.type).toBe(TemplateType.MARKETING);
    });

    it('rejects a negative step delay', () => {
      expect(
        SequenceSchemas.createStep.safeParse({subject: 'S', body: 'b', delayMinutes: -1}).success,
      ).toBe(false);
    });

    /**
     * The dashboard enters the delay in days, multiplying by 1440 before it gets
     * here, so the ceiling is what keeps an absurd entry from overflowing the
     * int4 column as a 500 instead of a validation error.
     */
    it('rejects a step delay past the ten-year ceiling, on create and on update', () => {
      expect(MAX_DELAY_MINUTES).toBe(3650 * 24 * 60);
      const tooLong = {subject: 'S', body: 'b', delayMinutes: MAX_DELAY_MINUTES + 1};
      expect(SequenceSchemas.createStep.safeParse(tooLong).success).toBe(false);
      expect(SequenceSchemas.updateStep.safeParse({delayMinutes: MAX_DELAY_MINUTES + 1}).success).toBe(false);
      expect(SequenceSchemas.createStep.safeParse({...tooLong, delayMinutes: MAX_DELAY_MINUTES}).success).toBe(true);
    });

    it('does not accept a published flag on step update (publishing is its own endpoint)', () => {
      const parsed = SequenceSchemas.updateStep.parse({subject: 'S', published: true} as never);
      expect(parsed).not.toHaveProperty('published');
    });

    it('accepts both enrollment selector modes', () => {
      const id = '00000000-0000-0000-0000-000000000000';
      expect(SequenceSchemas.enroll.safeParse({mode: 'ids', contactIds: [id]}).success).toBe(true);
      expect(SequenceSchemas.enroll.safeParse({mode: 'query', filter: {subscribed: true}}).success).toBe(true);
    });

    it('rejects an empty reorder list', () => {
      expect(SequenceSchemas.reorderSteps.safeParse({stepIds: []}).success).toBe(false);
    });
  });

  describe('sequence lifecycle', () => {
    it('creates a sequence as DRAFT with counts, then lists and fetches it', async () => {
      const created = await SequenceService.create(projectId, {name: 'Weekly', from: 'news@example.com'});
      expect(created.status).toBe(SequenceStatus.DRAFT);

      const step = await SequenceService.createStep(projectId, created.id, {
        subject: 'Issue 1',
        body: 'Hello',
        delayMinutes: 0,
      });

      const list = await SequenceService.list(projectId);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({id: created.id, stepCount: 1, subscriptionCount: 0});

      const fetched = await SequenceService.get(projectId, created.id);
      expect(fetched.steps.map(s => s.id)).toEqual([step.id]);
    });

    it('deletes a sequence and cascades its steps, subscriptions, and send records', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Doomed', from: 'news@example.com'});
      await activate(sequence.id);
      const step = await SequenceService.createStep(projectId, sequence.id, {
        subject: 'S',
        body: 'b',
        delayMinutes: 0,
      });
      const contact = await factories.createContact({projectId});
      await SequenceService.enroll(projectId, sequence.id, contact.id);

      await SequenceService.delete(projectId, sequence.id);

      expect(await prisma.sequenceStep.count({where: {id: step.id}})).toBe(0);
      expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id}})).toBe(0);
      expect(await prisma.sequenceStepSend.count({where: {sequenceId: sequence.id}})).toBe(0);
    });
  });

  describe('project scoping', () => {
    it('does not expose another project\'s sequence', async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreign = await SequenceService.create(other.id, {name: 'Theirs'});

      await expect(SequenceService.get(projectId, foreign.id)).rejects.toBeInstanceOf(NotFound);
      await expect(SequenceService.delete(projectId, foreign.id)).rejects.toBeInstanceOf(NotFound);
    });

    it('does not expose another project\'s step through our sequence id', async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreign = await SequenceService.create(other.id, {name: 'Theirs'});
      const foreignStep = await SequenceService.createStep(other.id, foreign.id, {
        subject: 'S',
        body: 'b',
        delayMinutes: 0,
      });

      const ours = await SequenceService.create(projectId, {name: 'Ours'});
      await expect(
        SequenceService.updateStep(projectId, ours.id, foreignStep.id, {subject: 'hijacked'}),
      ).rejects.toBeInstanceOf(NotFound);
    });

    it('rejects binding an enrolling tag from another project', async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreignTag = await prisma.tag.create({
        data: {projectId: other.id, name: 'Theirs', nameNorm: 'theirs'},
      });

      await expect(
        SequenceService.create(projectId, {name: 'Bound', enrollTagId: foreignTag.id}),
      ).rejects.toBeInstanceOf(NotFound);
    });
  });

  describe('enrollment endpoints', () => {
    it('rejects enrollment into a DRAFT sequence', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Draft'});
      const contact = await factories.createContact({projectId});

      await expect(SequenceService.enroll(projectId, sequence.id, contact.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(SequenceService.enrollMany(projectId, sequence.id, [contact.id])).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('enrolls many contacts idempotently', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Bulk', from: 'news@example.com'});
      await activate(sequence.id);
      const contacts = await factories.createContacts(projectId, 3);
      const ids = contacts.map(c => c.id);

      expect(await SequenceService.enrollMany(projectId, sequence.id, ids)).toEqual({enrolled: 3, skipped: 0});
      expect(await SequenceService.enrollMany(projectId, sequence.id, ids)).toEqual({enrolled: 0, skipped: 3});
    });

    it('unenrolling a contact who was never enrolled is a 404', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Empty', from: 'news@example.com'});
      await activate(sequence.id);
      const contact = await factories.createContact({projectId});

      await expect(SequenceService.unenroll(projectId, sequence.id, contact.id)).rejects.toBeInstanceOf(NotFound);
    });
  });

  describe('stats', () => {
    it('reports aggregate engagement from the sequence\'s emails', async () => {
      const sequence = await SequenceService.create(projectId, {name: 'Stats', from: 'news@example.com'});
      await activate(sequence.id);
      const step = await SequenceService.createStep(projectId, sequence.id, {
        subject: 'S',
        body: 'b',
        delayMinutes: 0,
      });
      await SequenceService.publishStep(projectId, sequence.id, step.id);

      const contacts = await factories.createContacts(projectId, 2);
      vi.spyOn(EmailService, 'sendCampaignEmail').mockImplementation(async params =>
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

      await SequenceService.enrollMany(
        projectId,
        sequence.id,
        contacts.map(c => c.id),
      );
      await SequenceService.sweepAllDue();

      // One of the two opens
      const [firstEmail] = await prisma.email.findMany({where: {sequenceId: sequence.id}, take: 1});
      await prisma.email.update({where: {id: firstEmail!.id}, data: {openedAt: new Date()}});

      const stats = await SequenceService.getStats(projectId, sequence.id);
      expect(stats).toMatchObject({sent: 2, opened: 1, clicked: 0, bounced: 0, complained: 0});
    });
  });
});
