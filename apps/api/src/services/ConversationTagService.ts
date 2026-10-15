import {Prisma} from '@plunk/db';
import type {InboxTag} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {ConflictError, NotFound} from '../exceptions/index.js';
import {Keys} from './keys.js';
import {RealtimeHub} from './RealtimeHub.js';

const MAX_TAGS = 500;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Labels for conversations, separate from contact tags: tagging a chat as "billing" says nothing
 * about the person, and deleting one never touches a contact.
 */
export class ConversationTagService {
  public static async list(projectId: string): Promise<InboxTag[]> {
    return prisma.conversationTag.findMany({
      where: {projectId},
      orderBy: [{nameNorm: 'asc'}],
      take: MAX_TAGS,
      select: {id: true, name: true},
    });
  }

  public static async create(projectId: string, name: string): Promise<InboxTag> {
    const clean = name.trim();
    try {
      return await prisma.conversationTag.create({
        data: {projectId, name: clean, nameNorm: this.normalize(clean)},
        select: {id: true, name: true},
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A tag named "${clean}" already exists`);
      }
      throw error;
    }
  }

  public static async rename(projectId: string, id: string, name: string): Promise<InboxTag> {
    const clean = name.trim();
    try {
      const {count} = await prisma.conversationTag.updateMany({
        where: {id, projectId},
        data: {name: clean, nameNorm: this.normalize(clean)},
      });
      if (count === 0) {
        throw new NotFound('Tag', id);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A tag named "${clean}" already exists`);
      }
      throw error;
    }
    await this.publishChange(projectId);
    return {id, name: clean};
  }

  /* Assignments go with the tag by cascade, in one statement however many conversations carry it. */
  public static async remove(projectId: string, id: string): Promise<void> {
    const {count} = await prisma.conversationTag.deleteMany({where: {id, projectId}});
    if (count === 0) {
      throw new NotFound('Tag', id);
    }
    await this.publishChange(projectId);
  }

  public static async apply(projectId: string, conversationId: string, tagId: string): Promise<InboxTag[]> {
    await this.requireBoth(projectId, conversationId, tagId);
    await prisma.conversationTagAssignment.createMany({data: [{conversationId, tagId}], skipDuplicates: true});
    return this.changed(projectId, conversationId);
  }

  public static async unapply(projectId: string, conversationId: string, tagId: string): Promise<InboxTag[]> {
    await this.requireBoth(projectId, conversationId, tagId);
    await prisma.conversationTagAssignment.deleteMany({where: {conversationId, tagId}});
    return this.changed(projectId, conversationId);
  }

  public static async forConversations(conversationIds: string[]): Promise<Map<string, InboxTag[]>> {
    const byConversation = new Map<string, InboxTag[]>();
    if (conversationIds.length === 0) {
      return byConversation;
    }
    const assignments = await prisma.conversationTagAssignment.findMany({
      where: {conversationId: {in: conversationIds}},
      select: {conversationId: true, tag: {select: {id: true, name: true, nameNorm: true}}},
    });
    assignments
      .sort((a, b) => a.tag.nameNorm.localeCompare(b.tag.nameNorm))
      .forEach(({conversationId, tag}) => {
        const list = byConversation.get(conversationId) ?? [];
        list.push({id: tag.id, name: tag.name});
        byConversation.set(conversationId, list);
      });
    return byConversation;
  }

  private static async requireBoth(projectId: string, conversationId: string, tagId: string): Promise<void> {
    const [conversation, tag] = await Promise.all([
      prisma.conversation.findFirst({where: {id: conversationId, projectId}, select: {id: true}}),
      prisma.conversationTag.findFirst({where: {id: tagId, projectId}, select: {id: true}}),
    ]);
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }
    if (!tag) {
      throw new NotFound('Tag', tagId);
    }
  }

  private static async changed(projectId: string, conversationId: string): Promise<InboxTag[]> {
    await RealtimeHub.publish(Keys.Realtime.project(projectId), {type: 'conversation', conversationId});
    return (await this.forConversations([conversationId])).get(conversationId) ?? [];
  }

  private static publishChange(projectId: string): Promise<void> {
    return RealtimeHub.publish(Keys.Realtime.project(projectId), {type: 'tags'});
  }

  private static normalize(name: string): string {
    return name.trim().toLowerCase();
  }
}
