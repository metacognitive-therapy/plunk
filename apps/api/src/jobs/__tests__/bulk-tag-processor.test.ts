import {beforeEach, describe, expect, it} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {TagService} from '../../services/TagService.js';
import {applyBatch, buildQueryWhere} from '../bulk-tag-processor.js';

/**
 * Tests for the bulk tag action processor's core helpers, mirroring
 * import-processor.test.ts's convention of testing an exported pure/service
 * helper directly rather than driving the BullMQ Worker end-to-end.
 */
describe('bulk-tag-processor', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  describe('buildQueryWhere', () => {
    it('builds a where clause with search, subscribed, tagIds, and excludeIds combined', () => {
      const where = buildQueryWhere(projectId, {
        mode: 'query',
        filter: {search: 'jane', subscribed: true, tagIds: ['tag-1', 'tag-2']},
        excludeIds: ['contact-9'],
      });

      expect(where).toMatchObject({
        projectId,
        email: {contains: 'jane', mode: 'insensitive'},
        subscribed: true,
        contactTags: {some: {tagId: {in: ['tag-1', 'tag-2']}}},
        id: {notIn: ['contact-9']},
      });
    });

    it('omits contactTags when no tagIds filter is present', () => {
      const where = buildQueryWhere(projectId, {mode: 'query', filter: {}});
      expect(where).not.toHaveProperty('contactTags');
    });
  });

  describe('applyBatch', () => {
    it('applies a tag to each contact and counts changed vs unchanged', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const untaggedContact = await factories.createContact({projectId});
      const alreadyTaggedContact = await factories.createContact({projectId});
      await TagService.applyTags(projectId, alreadyTaggedContact.id, [tag.id]);

      const result = await applyBatch(projectId, 'add', [tag.id], [untaggedContact.id, alreadyTaggedContact.id]);

      expect(result).toEqual({changed: 1, unchanged: 1, failed: 0});

      const memberships = await prisma.contactTag.findMany({where: {tagId: tag.id}});
      expect(memberships).toHaveLength(2);
    });

    it('removes a tag from each contact and counts changed vs unchanged', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const taggedContact = await factories.createContact({projectId});
      const untaggedContact = await factories.createContact({projectId});
      await TagService.applyTags(projectId, taggedContact.id, [tag.id]);

      const result = await applyBatch(projectId, 'remove', [tag.id], [taggedContact.id, untaggedContact.id]);

      expect(result).toEqual({changed: 1, unchanged: 1, failed: 0});

      const memberships = await prisma.contactTag.findMany({where: {tagId: tag.id}});
      expect(memberships).toHaveLength(0);
    });

    it('isolates one contact failure so the rest of the batch still tallies correctly', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const validContact = await factories.createContact({projectId});
      const nonexistentContactId = '00000000-0000-0000-0000-000000000000';

      const result = await applyBatch(projectId, 'add', [tag.id], [validContact.id, nonexistentContactId]);

      // Each contact is applied via its own TagService.applyTags call, so a
      // FK-violation on the nonexistent contact is caught individually and
      // doesn't discard the tally already accumulated for validContact.
      expect(result).toEqual({changed: 1, unchanged: 0, failed: 1});

      const membership = await prisma.contactTag.findUnique({
        where: {contactId_tagId: {contactId: validContact.id, tagId: tag.id}},
      });
      expect(membership).not.toBeNull();
    });
  });
});
