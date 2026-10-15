import {renderTemplate} from '@plunk/shared';
import type {SavedReply as SavedReplyDto} from '@plunk/types';
import type {SavedReply} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {NotFound} from '../exceptions/index.js';
import {assertValidTemplateSyntax} from '../utils/templateValidation.js';

const MAX_SAVED_REPLIES = 500;

/**
 * Canned answers for the inbox. Bodies use Plunk's template syntax and are rendered against the
 * conversation's contact when an agent inserts one, so the agent can still edit the result.
 */
export class SavedReplyService {
  public static async list(projectId: string): Promise<SavedReplyDto[]> {
    const replies = await prisma.savedReply.findMany({
      where: {projectId},
      orderBy: [{title: 'asc'}, {id: 'asc'}],
      take: MAX_SAVED_REPLIES,
    });
    return replies.map(reply => this.toDto(reply));
  }

  public static async create(projectId: string, input: {title: string; body: string}): Promise<SavedReplyDto> {
    assertValidTemplateSyntax({body: input.body});
    const reply = await prisma.savedReply.create({data: {projectId, title: input.title, body: input.body}});
    return this.toDto(reply);
  }

  public static async update(
    projectId: string,
    id: string,
    input: {title?: string; body?: string},
  ): Promise<SavedReplyDto> {
    if (input.body !== undefined) {
      assertValidTemplateSyntax({body: input.body});
    }
    const {count} = await prisma.savedReply.updateMany({where: {id, projectId}, data: input});
    if (count === 0) {
      throw new NotFound('Saved reply', id);
    }
    return this.toDto(await prisma.savedReply.findUniqueOrThrow({where: {id}}));
  }

  public static async remove(projectId: string, id: string): Promise<void> {
    const {count} = await prisma.savedReply.deleteMany({where: {id, projectId}});
    if (count === 0) {
      throw new NotFound('Saved reply', id);
    }
  }

  public static async render(projectId: string, id: string, conversationId: string): Promise<{body: string}> {
    const [reply, conversation] = await Promise.all([
      prisma.savedReply.findFirst({where: {id, projectId}}),
      prisma.conversation.findFirst({
        where: {id: conversationId, projectId},
        select: {contact: {select: {id: true, email: true, data: true}}},
      }),
    ]);
    if (!reply) {
      throw new NotFound('Saved reply', id);
    }
    if (!conversation) {
      throw new NotFound('Conversation', conversationId);
    }

    const {contact} = conversation;
    const data =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};
    return {body: renderTemplate(reply.body, {id: contact.id, email: contact.email, ...data, data})};
  }

  private static toDto(reply: SavedReply): SavedReplyDto {
    return {
      id: reply.id,
      title: reply.title,
      body: reply.body,
      updatedAt: reply.updatedAt.toISOString(),
    };
  }
}
