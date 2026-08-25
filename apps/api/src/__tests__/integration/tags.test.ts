import {beforeEach, describe, expect, it} from 'vitest';
import {ActionSchemas, TagSchemas} from '@plunk/shared';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ConflictError} from '../../exceptions/index.js';
import {ContactService} from '../../services/ContactService.js';
import {EventService} from '../../services/EventService.js';
import {TagService} from '../../services/TagService.js';

/**
 * Integration tests for the /tags endpoints and the tags side of /v1/track.
 * This codebase's "integration" tests exercise the request schema plus the
 * service layer the controllers call directly (see actions.test.ts /
 * campaigns.test.ts for the same pattern) rather than booting a live HTTP
 * server, so these mirror that convention.
 */
describe('Tags API Integration Tests', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  describe('request validation', () => {
    it('rejects an empty tag name on create', () => {
      const result = TagSchemas.create.safeParse({name: '   '});
      expect(result.success).toBe(false);
    });

    it('rejects a tag name over 100 characters', () => {
      const result = TagSchemas.create.safeParse({name: 'a'.repeat(101)});
      expect(result.success).toBe(false);
    });

    it('accepts a valid rename payload', () => {
      const result = TagSchemas.update.safeParse({name: 'VIP'});
      expect(result.success).toBe(true);
    });

    it('rejects a bulk-apply ids-mode payload with no tagIds', () => {
      const result = TagSchemas.bulkApply.safeParse({
        mode: 'ids',
        contactIds: ['00000000-0000-0000-0000-000000000000'],
        tagIds: [],
        action: 'add',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a bulk-apply query-mode payload carrying a tagIds filter', () => {
      const result = TagSchemas.bulkApply.safeParse({
        mode: 'query',
        filter: {tagIds: ['00000000-0000-0000-0000-000000000000']},
        tagIds: ['11111111-1111-1111-1111-111111111111'],
        action: 'remove',
      });
      expect(result.success).toBe(true);
    });

    it('accepts /v1/track payloads with a tags array', () => {
      const result = ActionSchemas.track.safeParse({
        event: 'signup',
        email: 'user@example.com',
        tags: ['VIP', 'newsletter'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects /v1/track payloads with more than 20 tags', () => {
      const result = ActionSchemas.track.safeParse({
        event: 'signup',
        email: 'user@example.com',
        tags: Array.from({length: 21}, (_, i) => `tag-${i}`),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('CRUD lifecycle (TagService, as invoked by the Tags controller)', () => {
    it('creates, lists, fetches, renames, and deletes a tag', async () => {
      const parsedCreate = TagSchemas.create.parse({name: '  VIP  '});
      const tag = await TagService.create(projectId, parsedCreate.name);
      expect(tag.name).toBe('VIP');

      const listed = await TagService.list(projectId);
      expect(listed.map(t => t.id)).toContain(tag.id);

      const fetched = await TagService.get(projectId, tag.id);
      expect(fetched.id).toBe(tag.id);

      const parsedUpdate = TagSchemas.update.parse({name: 'Gold'});
      const renamed = await TagService.rename(projectId, tag.id, parsedUpdate.name);
      expect(renamed.name).toBe('Gold');

      await TagService.delete(projectId, tag.id);
      await expect(TagService.get(projectId, tag.id)).rejects.toThrow();
    });

    it('paginates GET /tags/:id/contacts', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const contacts = await Promise.all(
        Array.from({length: 25}, () => factories.createContact({projectId})),
      );
      await TagService.applyTags(
        projectId,
        contacts[0].id,
        [tag.id],
      );
      for (const contact of contacts) {
        await TagService.applyTags(projectId, contact.id, [tag.id]);
      }

      const page1 = await TagService.getContacts(projectId, tag.id, 1, 10);
      expect(page1.data).toHaveLength(10);
      expect(page1.total).toBe(25);
      expect(page1.totalPages).toBe(3);

      const page3 = await TagService.getContacts(projectId, tag.id, 3, 10);
      expect(page3.data).toHaveLength(5);
    });
  });

  describe('POST /v1/track with tags', () => {
    it('auto-creates tags by name, applies them, and fires tag.added', async () => {
      const parsed = ActionSchemas.track.parse({
        event: 'signup',
        email: 'newuser@example.com',
        tags: ['VIP', 'newsletter'],
      });

      const contact = await ContactService.upsert(projectId, parsed.email, undefined, parsed.subscribed);
      await EventService.trackEvent(projectId, parsed.event, contact.id, undefined, undefined);

      expect(parsed.tags).toBeDefined();
      const resolvedTags = await TagService.resolveOrCreateByNames(projectId, parsed.tags!);
      expect(resolvedTags).toHaveLength(2);

      const result = await TagService.applyTags(
        projectId,
        contact.id,
        resolvedTags.map(t => t.id),
      );
      expect(result).toEqual({added: 2, unchanged: 0});

      const membership = await prisma.contactTag.findMany({where: {contactId: contact.id}});
      expect(membership).toHaveLength(2);

      const tagAddedEvents = await prisma.event.findMany({
        where: {projectId, contactId: contact.id, name: 'tag.added'},
      });
      expect(tagAddedEvents).toHaveLength(2);
    });

    it('reuses an existing tag by case-insensitive name instead of duplicating it', async () => {
      const existing = await TagService.create(projectId, 'VIP');

      const parsed = ActionSchemas.track.parse({
        event: 'signup',
        email: 'existing@example.com',
        tags: ['vip'],
      });

      const contact = await ContactService.upsert(projectId, parsed.email, undefined, parsed.subscribed);
      const resolvedTags = await TagService.resolveOrCreateByNames(projectId, parsed.tags!);

      expect(resolvedTags).toHaveLength(1);
      expect(resolvedTags[0]!.id).toBe(existing.id);

      await TagService.applyTags(projectId, contact.id, resolvedTags.map(t => t.id));

      const allTags = await TagService.list(projectId);
      expect(allTags.filter(t => t.nameNorm === 'vip')).toHaveLength(1);
    });

    it('rejects manually tracking a reserved tag.* event name', () => {
      expect(EventService.isReservedEvent('tag.added')).toBe(true);
      expect(EventService.isReservedEvent('tag.removed')).toBe(true);
    });
  });

  describe('single-contact apply/remove endpoints', () => {
    it('applies then removes tags for a single contact', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const applyResult = await TagService.applyTags(projectId, contact.id, [tag.id]);
      expect(applyResult).toEqual({added: 1, unchanged: 0});

      const removeResult = await TagService.removeTags(projectId, contact.id, [tag.id]);
      expect(removeResult).toEqual({removed: 1, unchanged: 0});
    });
  });

  describe('deletion is blocked by active references', () => {
    it('rejects deleting a tag referenced by a campaign', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const campaign = await factories.createCampaign({projectId});
      await prisma.campaign.update({where: {id: campaign.id}, data: {tagIds: [tag.id]}});

      const error = await TagService.delete(projectId, tag.id).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({campaigns: 1});
    });
  });
});
