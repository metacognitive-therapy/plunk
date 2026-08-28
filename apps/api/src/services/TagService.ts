import type {Tag} from '@plunk/db';
import {Prisma} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {ConflictError, NotFound} from '../exceptions/index.js';

import {EventService} from './EventService.js';

export interface TagApplyResult {
  added: number; // number of contacts that newly received the tag
  unchanged: number; // number of contacts that already had the tag
}

export interface TagRemoveResult {
  removed: number;
  unchanged: number;
}

/**
 * Tag Service
 *
 * Tags are lightweight, project-scoped labels for contacts (ConvertKit-style).
 * Identity is case-insensitive and trim-normalized (see `normalizeName`) so API
 * typos like "VIP" / "vip" / " vip " never fork into separate tags. Everything
 * that references a tag (campaigns, workflows, segment/filter conditions) binds
 * by tag id, never by name, so renaming a tag is always safe.
 *
 * Membership (`ContactTag`) is a hard-delete model: removing a tag deletes the
 * row outright (no soft-exit / history, unlike `SegmentMembership`). Applying
 * and removing a tag are both no-ops when the contact's membership already
 * matches the desired state - no duplicate `tag.added` / `tag.removed` events,
 * no double-counted `memberCount`.
 */
export class TagService {
  /**
   * Normalize a tag name for case-insensitive identity: trim, then lowercase.
   */
  public static normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }

  public static async list(projectId: string): Promise<Tag[]> {
    return prisma.tag.findMany({
      where: {projectId},
      orderBy: {name: 'asc'},
    });
  }

  public static async get(projectId: string, tagId: string): Promise<Tag> {
    const tag = await prisma.tag.findFirst({where: {id: tagId, projectId}});
    if (!tag) {
      throw new NotFound('tag');
    }
    return tag;
  }

  /**
   * Create a new tag. Throws ConflictError if a tag with the same
   * (case-insensitive, trimmed) name already exists in the project.
   */
  public static async create(projectId: string, name: string): Promise<Tag> {
    const nameNorm = this.normalizeName(name);
    if (!nameNorm) {
      throw new ConflictError('Tag name cannot be empty');
    }

    const existing = await prisma.tag.findUnique({
      where: {projectId_nameNorm: {projectId, nameNorm}},
    });
    if (existing) {
      throw new ConflictError(`A tag named "${existing.name}" already exists`, {tagId: existing.id});
    }

    return prisma.tag.create({
      data: {projectId, name: name.trim(), nameNorm},
    });
  }

  /**
   * Find tags by name (case-insensitive, trimmed), creating any that don't
   * exist yet. Used by /v1/track, CSV import, and workflow steps that
   * reference tags by name rather than id.
   */
  public static async resolveOrCreateByNames(projectId: string, names: string[]): Promise<Tag[]> {
    const uniqueNorms = new Map<string, string>(); // nameNorm -> original (trimmed) name
    for (const raw of names) {
      const trimmed = raw.trim();
      const norm = this.normalizeName(raw);
      if (norm) uniqueNorms.set(norm, trimmed);
    }
    if (uniqueNorms.size === 0) return [];

    const norms = [...uniqueNorms.keys()];
    const existing = await prisma.tag.findMany({
      where: {projectId, nameNorm: {in: norms}},
    });
    const existingByNorm = new Map(existing.map(t => [t.nameNorm, t]));

    const missing = norms.filter(n => !existingByNorm.has(n));
    const created: Tag[] = [];
    for (const norm of missing) {
      // Sequential create + fallback-to-existing handles the race where two
      // requests auto-create the same missing tag concurrently.
      try {
        const tag = await prisma.tag.create({
          data: {projectId, name: uniqueNorms.get(norm)!, nameNorm: norm},
        });
        created.push(tag);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const tag = await prisma.tag.findUnique({where: {projectId_nameNorm: {projectId, nameNorm: norm}}});
          if (tag) created.push(tag);
          continue;
        }
        throw error;
      }
    }

    return [...existing, ...created];
  }

  public static async rename(projectId: string, tagId: string, name: string): Promise<Tag> {
    const tag = await this.get(projectId, tagId);
    const nameNorm = this.normalizeName(name);
    if (!nameNorm) {
      throw new ConflictError('Tag name cannot be empty');
    }

    if (nameNorm !== tag.nameNorm) {
      const conflict = await prisma.tag.findUnique({where: {projectId_nameNorm: {projectId, nameNorm}}});
      if (conflict && conflict.id !== tagId) {
        throw new ConflictError(`A tag named "${conflict.name}" already exists`, {tagId: conflict.id});
      }
    }

    return prisma.tag.update({
      where: {id: tagId},
      data: {name: name.trim(), nameNorm},
    });
  }

  /**
   * Delete a tag. Blocked (409) if referenced by a campaign's tagIds/
   * excludeTagIds, an enabled workflow (tag trigger or ADD_TAG/REMOVE_TAG
   * step), or any segment/filter condition (hasTag/notHasTag) - mirrors
   * SegmentService.delete's campaign-reference guard.
   */
  public static async delete(projectId: string, tagId: string): Promise<void> {
    await this.get(projectId, tagId);

    const [campaignCount, workflowTriggerCount, workflowStepCount, segmentCount] = await Promise.all([
      prisma.campaign.count({
        where: {
          projectId,
          OR: [{tagIds: {has: tagId}}, {excludeTagIds: {has: tagId}}],
        },
      }),
      prisma.workflow.count({
        where: {
          projectId,
          enabled: true,
          triggerConfig: {path: ['tagId'], equals: tagId},
        },
      }),
      prisma.workflowStep.count({
        where: {
          workflow: {projectId, enabled: true},
          type: {in: ['ADD_TAG', 'REMOVE_TAG']},
          config: {path: ['tagId'], equals: tagId},
        },
      }),
      // Segment/filter conditions are an arbitrary nested AND/OR tree, so there's
      // no fixed JSON path to query. A raw text-containment check on the id is a
      // deliberately conservative approximation: false positives (a segment that
      // happens to mention the id elsewhere) block deletion needlessly rather
      // than letting a real reference silently break - the safe direction to err.
      prisma.$queryRaw<{count: bigint}[]>(
        Prisma.sql`SELECT count(*)::bigint AS count FROM segments WHERE "projectId" = ${projectId} AND condition::text LIKE ${'%' + tagId + '%'}`,
      ),
    ]);

    const segmentRefCount = Number(segmentCount[0]?.count ?? 0);
    const references: string[] = [];
    if (campaignCount > 0) references.push(`${campaignCount} campaign(s)`);
    if (workflowTriggerCount > 0) references.push(`${workflowTriggerCount} workflow trigger(s)`);
    if (workflowStepCount > 0) references.push(`${workflowStepCount} workflow step(s)`);
    if (segmentRefCount > 0) references.push(`${segmentRefCount} segment(s)`);

    if (references.length > 0) {
      throw new ConflictError(`Cannot delete tag: referenced by ${references.join(', ')}`, {
        campaigns: campaignCount,
        workflowTriggers: workflowTriggerCount,
        workflowSteps: workflowStepCount,
        segments: segmentRefCount,
      });
    }

    await prisma.tag.delete({where: {id: tagId}});
  }

  public static async getContacts(projectId: string, tagId: string, page: number, pageSize: number) {
    await this.get(projectId, tagId);

    const [total, memberships] = await Promise.all([
      prisma.contactTag.count({where: {tagId}}),
      prisma.contactTag.findMany({
        where: {tagId},
        include: {contact: true},
        orderBy: {createdAt: 'desc'},
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      data: memberships.map(m => m.contact),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Apply one or more tags to a contact. Applying a tag the contact already
   * has is a silent no-op (no event, no count change) - re-adding a
   * previously-removed tag does fire tag.added again.
   */
  public static async applyTags(projectId: string, contactId: string, tagIds: string[]): Promise<TagApplyResult> {
    if (tagIds.length === 0) return {added: 0, unchanged: 0};

    const uniqueTagIds = [...new Set(tagIds)];
    const existingMemberships = await prisma.contactTag.findMany({
      where: {contactId, tagId: {in: uniqueTagIds}},
      select: {tagId: true},
    });
    const alreadyTagged = new Set(existingMemberships.map(m => m.tagId));
    const toAdd = uniqueTagIds.filter(id => !alreadyTagged.has(id));

    if (toAdd.length === 0) {
      return {added: 0, unchanged: uniqueTagIds.length};
    }

    const tags = await prisma.tag.findMany({where: {id: {in: toAdd}, projectId}});
    if (tags.length === 0) {
      return {added: 0, unchanged: uniqueTagIds.length};
    }

    await prisma.contactTag.createMany({
      data: tags.map(tag => ({contactId, tagId: tag.id})),
      skipDuplicates: true,
    });
    await prisma.tag.updateMany({
      where: {id: {in: tags.map(t => t.id)}},
      data: {memberCount: {increment: 1}},
    });

    for (const tag of tags) {
      await EventService.trackEvent(projectId, 'tag.added', contactId, undefined, {
        tagId: tag.id,
        tagName: tag.name,
      });
    }

    return {added: tags.length, unchanged: uniqueTagIds.length - tags.length};
  }

  /**
   * Apply one or more tags to a contact WITHOUT emitting `tag.added`.
   *
   * Used exclusively by `ContactService.identify`: applying a tag through the normal
   * event-emitting path (`applyTags`) routes into `SequenceEnrollmentService.handleTagAdded`,
   * which would auto-enrol the contact into every sequence bound to any of the tags,
   * simultaneously. That's fine for tags earned one at a time over the contact's lifetime, but
   * identify-time tag movement can apply several tags in a single call (e.g. a guest converting
   * with tags earned as a lead), and firing enrolment for all of them at once would flood a
   * brand-new contact with automations. Otherwise identical to `applyTags`: same
   * already-tagged no-op, same `memberCount` bookkeeping.
   */
  public static async applyTagsDirect(projectId: string, contactId: string, tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;

    const uniqueTagIds = [...new Set(tagIds)];
    const existingMemberships = await prisma.contactTag.findMany({
      where: {contactId, tagId: {in: uniqueTagIds}},
      select: {tagId: true},
    });
    const alreadyTagged = new Set(existingMemberships.map(m => m.tagId));
    const toAdd = uniqueTagIds.filter(id => !alreadyTagged.has(id));

    if (toAdd.length === 0) return;

    const tags = await prisma.tag.findMany({where: {id: {in: toAdd}, projectId}});
    if (tags.length === 0) return;

    await prisma.contactTag.createMany({
      data: tags.map(tag => ({contactId, tagId: tag.id})),
      skipDuplicates: true,
    });
    await prisma.tag.updateMany({
      where: {id: {in: tags.map(t => t.id)}},
      data: {memberCount: {increment: 1}},
    });
  }

  /**
   * Remove one or more tags from a contact. Removing a tag the contact
   * doesn't have is a silent no-op.
   */
  public static async removeTags(projectId: string, contactId: string, tagIds: string[]): Promise<TagRemoveResult> {
    if (tagIds.length === 0) return {removed: 0, unchanged: 0};

    const uniqueTagIds = [...new Set(tagIds)];
    const existingMemberships = await prisma.contactTag.findMany({
      where: {contactId, tagId: {in: uniqueTagIds}},
      include: {tag: true},
    });

    if (existingMemberships.length === 0) {
      return {removed: 0, unchanged: uniqueTagIds.length};
    }

    const removedTagIds = existingMemberships.map(m => m.tagId);
    await prisma.contactTag.deleteMany({
      where: {contactId, tagId: {in: removedTagIds}},
    });
    await prisma.tag.updateMany({
      where: {id: {in: removedTagIds}},
      data: {memberCount: {decrement: 1}},
    });

    for (const membership of existingMemberships) {
      await EventService.trackEvent(projectId, 'tag.removed', contactId, undefined, {
        tagId: membership.tag.id,
        tagName: membership.tag.name,
      });
    }

    return {removed: removedTagIds.length, unchanged: uniqueTagIds.length - removedTagIds.length};
  }

  /**
   * Reconcile cached memberCount against actual ContactTag rows for every tag
   * in a project. applyTags/removeTags increment/decrement optimistically;
   * this sweep (run periodically, see segment-count-processor) corrects any
   * drift rather than counting live on every read.
   */
  public static async refreshAllMemberCounts(projectId: string): Promise<void> {
    const tags = await prisma.tag.findMany({where: {projectId}, select: {id: true}});
    for (const tag of tags) {
      const count = await prisma.contactTag.count({where: {tagId: tag.id}});
      await prisma.tag.update({where: {id: tag.id}, data: {memberCount: count}});
    }
  }
}
