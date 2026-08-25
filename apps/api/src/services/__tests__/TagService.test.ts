import {CampaignAudienceType, WorkflowStepType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {ConflictError} from '../../exceptions/index.js';
import {SegmentService} from '../SegmentService.js';
import {TagService} from '../TagService.js';
import {factories, getPrismaClient} from '../../../../../test/helpers';

describe('TagService', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  describe('create', () => {
    it('trims and lowercases for identity, but preserves display casing', async () => {
      const tag = await TagService.create(projectId, '  VIP  ');

      expect(tag.name).toBe('VIP');
      expect(tag.nameNorm).toBe('vip');
    });

    it('rejects a second tag whose name only differs by case/whitespace', async () => {
      const original = await TagService.create(projectId, 'VIP');

      const error = await TagService.create(projectId, ' vip ').catch(e => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({tagId: original.id});
    });

    it('rejects an empty (or whitespace-only) name', async () => {
      await expect(TagService.create(projectId, '   ')).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('resolveOrCreateByNames', () => {
    it('creates missing tags and reuses existing ones by case-insensitive name', async () => {
      const existing = await TagService.create(projectId, 'Newsletter');

      const tags = await TagService.resolveOrCreateByNames(projectId, ['newsletter', 'VIP']);

      expect(tags).toHaveLength(2);
      expect(tags.find(t => t.id === existing.id)).toBeTruthy();
      expect(tags.find(t => t.nameNorm === 'vip')).toBeTruthy();
    });

    it('dedupes repeated names within the same call', async () => {
      const tags = await TagService.resolveOrCreateByNames(projectId, ['VIP', 'vip', ' VIP ']);

      expect(tags).toHaveLength(1);
    });
  });

  describe('rename', () => {
    it('renames freely and campaign/workflow/segment bindings still resolve by id', async () => {
      const tag = await TagService.create(projectId, 'Old Name');

      const campaign = await factories.createCampaign({
        projectId,
        audienceType: CampaignAudienceType.TAG,
      });
      await prisma.campaign.update({where: {id: campaign.id}, data: {tagIds: [tag.id]}});

      const workflow = await factories.createWorkflow({
        projectId,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      const segment = await factories.createSegment(projectId, {
        filters: [{field: 'tags', operator: 'hasTag', value: tag.id}],
      });

      const renamed = await TagService.rename(projectId, tag.id, 'New Name');
      expect(renamed.name).toBe('New Name');
      expect(renamed.nameNorm).toBe('new name');

      const reloadedCampaign = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
      expect(reloadedCampaign.tagIds).toContain(tag.id);

      const reloadedWorkflow = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}});
      expect((reloadedWorkflow.triggerConfig as {tagId?: string})?.tagId).toBe(tag.id);

      const reloadedSegment = await prisma.segment.findUniqueOrThrow({where: {id: segment.id}});
      expect(JSON.stringify(reloadedSegment.condition)).toContain(tag.id);
    });

    it('rejects renaming to a name already used by another tag', async () => {
      await TagService.create(projectId, 'VIP');
      const other = await TagService.create(projectId, 'Newsletter');

      await expect(TagService.rename(projectId, other.id, 'vip')).rejects.toBeInstanceOf(ConflictError);
    });

    it('allows renaming a tag to a case variant of its own current name', async () => {
      const tag = await TagService.create(projectId, 'VIP');

      const renamed = await TagService.rename(projectId, tag.id, 'Vip');
      expect(renamed.name).toBe('Vip');
    });
  });

  describe('applyTags / removeTags', () => {
    it('applies a tag, increments memberCount, and fires tag.added', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const result = await TagService.applyTags(projectId, contact.id, [tag.id]);

      expect(result).toEqual({added: 1, unchanged: 0});

      const reloadedTag = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloadedTag.memberCount).toBe(1);

      const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.added'}});
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({tagId: tag.id, tagName: tag.name});
    });

    it('is a silent no-op when applying a tag the contact already has', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      await TagService.applyTags(projectId, contact.id, [tag.id]);
      const secondResult = await TagService.applyTags(projectId, contact.id, [tag.id]);

      expect(secondResult).toEqual({added: 0, unchanged: 1});

      const reloadedTag = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloadedTag.memberCount).toBe(1);

      const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.added'}});
      expect(events).toHaveLength(1);
    });

    it('is a silent no-op when removing a tag the contact does not have', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const result = await TagService.removeTags(projectId, contact.id, [tag.id]);

      expect(result).toEqual({removed: 0, unchanged: 1});

      const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.removed'}});
      expect(events).toHaveLength(0);
    });

    it('removes a tag, decrements memberCount, and fires tag.removed', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');
      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const result = await TagService.removeTags(projectId, contact.id, [tag.id]);
      expect(result).toEqual({removed: 1, unchanged: 0});

      const reloadedTag = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloadedTag.memberCount).toBe(0);

      const membership = await prisma.contactTag.findUnique({
        where: {contactId_tagId: {contactId: contact.id, tagId: tag.id}},
      });
      expect(membership).toBeNull();

      const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.removed'}});
      expect(events).toHaveLength(1);
    });

    it('fires tag.added again when re-adding a previously-removed tag', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      await TagService.applyTags(projectId, contact.id, [tag.id]);
      await TagService.removeTags(projectId, contact.id, [tag.id]);
      const result = await TagService.applyTags(projectId, contact.id, [tag.id]);

      expect(result).toEqual({added: 1, unchanged: 0});

      const reloadedTag = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloadedTag.memberCount).toBe(1);

      const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.added'}});
      expect(events).toHaveLength(2);
    });
  });

  describe('refreshAllMemberCounts', () => {
    it('reconciles memberCount against actual ContactTag rows', async () => {
      const contactA = await factories.createContact({projectId});
      const contactB = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      await TagService.applyTags(projectId, contactA.id, [tag.id]);
      await TagService.applyTags(projectId, contactB.id, [tag.id]);

      // Force the cache out of sync with reality.
      await prisma.tag.update({where: {id: tag.id}, data: {memberCount: 999}});

      await TagService.refreshAllMemberCounts(projectId);

      const reloaded = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloaded.memberCount).toBe(2);
    });
  });

  describe('delete', () => {
    it('deletes an unreferenced tag and its ContactTag rows', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');
      await TagService.applyTags(projectId, contact.id, [tag.id]);

      await TagService.delete(projectId, tag.id);

      await expect(prisma.tag.findUniqueOrThrow({where: {id: tag.id}})).rejects.toThrow();
      const membership = await prisma.contactTag.findUnique({
        where: {contactId_tagId: {contactId: contact.id, tagId: tag.id}},
      });
      expect(membership).toBeNull();
    });

    it('blocks deletion when referenced by a campaign', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.TAG});
      await prisma.campaign.update({where: {id: campaign.id}, data: {tagIds: [tag.id]}});

      const error = await TagService.delete(projectId, tag.id).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({campaigns: 1});
    });

    it('blocks deletion when referenced by an excludeTagIds list', async () => {
      const tag = await TagService.create(projectId, 'Opt-out');
      const campaign = await factories.createCampaign({projectId, audienceType: CampaignAudienceType.TAG});
      await prisma.campaign.update({where: {id: campaign.id}, data: {tagIds: ['placeholder'], excludeTagIds: [tag.id]}});

      await expect(TagService.delete(projectId, tag.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('blocks deletion when referenced by an enabled workflow trigger', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      const error = await TagService.delete(projectId, tag.id).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({workflowTriggers: 1});
    });

    it('does not block deletion when the referencing workflow trigger is disabled', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      await factories.createWorkflow({
        projectId,
        enabled: false,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      await expect(TagService.delete(projectId, tag.id)).resolves.toBeUndefined();
    });

    it('blocks deletion when referenced by an enabled workflow ADD_TAG/REMOVE_TAG step', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      const workflow = await factories.createWorkflow({projectId, enabled: true});
      await factories.createWorkflowStep({
        workflowId: workflow.id,
        type: WorkflowStepType.ADD_TAG,
        config: {tagId: tag.id},
      });

      const error = await TagService.delete(projectId, tag.id).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({workflowSteps: 1});
    });

    it('blocks deletion when referenced by a segment hasTag/notHasTag condition', async () => {
      const tag = await TagService.create(projectId, 'VIP');
      await factories.createSegment(projectId, {
        filters: [{field: 'tags', operator: 'hasTag', value: tag.id}],
      });

      const error = await TagService.delete(projectId, tag.id).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({segments: 1});
    });
  });

  describe('hasTag / notHasTag filter operators', () => {
    it('matches contacts that have the tag with hasTag, and excludes them with notHasTag', async () => {
      const tagged = await factories.createContact({projectId});
      const untagged = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');
      await TagService.applyTags(projectId, tagged.id, [tag.id]);

      const hasTagSegment = await factories.createSegment(projectId, {
        name: 'Has VIP',
        filters: [{field: 'tags', operator: 'hasTag', value: tag.id}],
      });
      const hasTagResult = await SegmentService.getContacts(projectId, hasTagSegment.id);
      expect(hasTagResult.data.map(c => c.id)).toEqual([tagged.id]);

      const notHasTagSegment = await factories.createSegment(projectId, {
        name: 'Not VIP',
        filters: [{field: 'tags', operator: 'notHasTag', value: tag.id}],
      });
      const notHasTagResult = await SegmentService.getContacts(projectId, notHasTagSegment.id);
      const notHasTagIds = notHasTagResult.data.map(c => c.id);
      expect(notHasTagIds).toContain(untagged.id);
      expect(notHasTagIds).not.toContain(tagged.id);
    });
  });
});
