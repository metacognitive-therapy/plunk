import {SequenceStatus} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {SequenceService} from '../SequenceService.js';
import {TagService} from '../TagService.js';
import {factories, getPrismaClient} from '../../../../../test/helpers';

/**
 * Tag-driven sequence auto-enrollment: applying a tag enrolls the contact into
 * every ACTIVE sequence bound to that tag, via the tag.added fan-out in
 * EventService.trackEvent. See EventService.tags.test.ts for the workflow-side
 * dispatch this sits alongside.
 */
describe('EventService - tag-driven sequence enrollment', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  async function createSequenceBoundTo(tagId: string, status: SequenceStatus) {
    const sequence = await SequenceService.create(projectId, {
      name: `Bound to ${tagId}`,
      from: 'news@example.com',
      enrollTagId: tagId,
    });
    await prisma.sequence.update({where: {id: sequence.id}, data: {status}});
    return sequence;
  }

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  it('enrolls the contact when the bound tag is applied', async () => {
    const tag = await TagService.create(projectId, 'VIP');
    const sequence = await createSequenceBoundTo(tag.id, SequenceStatus.ACTIVE);
    const contact = await factories.createContact({projectId});

    await TagService.applyTags(projectId, contact.id, [tag.id]);

    const subscriptions = await prisma.sequenceSubscription.findMany({
      where: {sequenceId: sequence.id, contactId: contact.id},
    });
    expect(subscriptions).toHaveLength(1);
  });

  it('does not enroll when a different tag is applied', async () => {
    const boundTag = await TagService.create(projectId, 'VIP');
    const otherTag = await TagService.create(projectId, 'Newsletter');
    const sequence = await createSequenceBoundTo(boundTag.id, SequenceStatus.ACTIVE);
    const contact = await factories.createContact({projectId});

    await TagService.applyTags(projectId, contact.id, [otherTag.id]);

    expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id}})).toBe(0);
  });

  it('ignores DRAFT and PAUSED sequences bound to the tag', async () => {
    const tag = await TagService.create(projectId, 'VIP');
    const draft = await createSequenceBoundTo(tag.id, SequenceStatus.DRAFT);
    const paused = await createSequenceBoundTo(tag.id, SequenceStatus.PAUSED);
    const contact = await factories.createContact({projectId});

    await TagService.applyTags(projectId, contact.id, [tag.id]);

    expect(await prisma.sequenceSubscription.count({where: {sequenceId: {in: [draft.id, paused.id]}}})).toBe(0);
  });

  it('is idempotent when the tag is removed and re-applied', async () => {
    const tag = await TagService.create(projectId, 'VIP');
    const sequence = await createSequenceBoundTo(tag.id, SequenceStatus.ACTIVE);
    const contact = await factories.createContact({projectId});

    await TagService.applyTags(projectId, contact.id, [tag.id]);
    await TagService.removeTags(projectId, contact.id, [tag.id]);
    await TagService.applyTags(projectId, contact.id, [tag.id]);

    expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id, contactId: contact.id}})).toBe(1);
  });

  it('removing the tag does not unenroll the contact', async () => {
    const tag = await TagService.create(projectId, 'VIP');
    const sequence = await createSequenceBoundTo(tag.id, SequenceStatus.ACTIVE);
    const contact = await factories.createContact({projectId});

    await TagService.applyTags(projectId, contact.id, [tag.id]);
    await TagService.removeTags(projectId, contact.id, [tag.id]);

    expect(await prisma.sequenceSubscription.count({where: {sequenceId: sequence.id, contactId: contact.id}})).toBe(1);
  });
});
