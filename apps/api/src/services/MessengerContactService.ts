import {type Contact, Prisma} from '@plunk/db';
import {CHAT_EVENTS, CONTACT_IDENTITY_TYPES} from '@plunk/shared';
import type {MessengerEmailResponse} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {ConflictError, ErrorCode, HttpException, NotFound} from '../exceptions/index.js';
import {ContactService} from './ContactService.js';
import {EventService} from './EventService.js';
import {Keys} from './keys.js';
import {type MessengerSession, MessengerSessionService} from './MessengerSessionService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';
import {RealtimeHub} from './RealtimeHub.js';

export const EMAIL_CAPTURED_EVENT = CHAT_EVENTS.EMAIL_CAPTURED;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Ties a messenger visitor to a contact. Visitors start as leads keyed by their anonymous id and
 * may later give an email, which never makes the session trusted: a visitor who types someone
 * else's address only moves their own lead onto that contact and still sees only the
 * conversations their own device started. Only a user token signed by the customer's backend
 * makes a session verified, and only a verified session sees all of its contact's conversations.
 */
export class MessengerContactService {
  /**
   * The conversations a session may see. Keyed on `verified`, never on `contactId` being set: an
   * anonymous lead merged by email has a contact too, and must not see other devices' chats.
   */
  public static conversationScope(session: MessengerSession): Prisma.ConversationWhereInput {
    if (session.verified && session.contactId) {
      return {projectId: session.projectId, contactId: session.contactId};
    }
    return {projectId: session.projectId, originVisitorId: session.visitorId};
  }

  /**
   * Signs a visitor in with a user token: the contact is resolved by the identify rules (external
   * id first, then email, refusing a conflict), and the visitor's bare anonymous lead, if any, is
   * folded into it so the chats they started before signing in come along.
   */
  public static async identifyVisitor(projectId: string, visitorId: string, userToken: string): Promise<Contact> {
    const secret = await MessengerSettingsService.identitySecret(projectId);
    if (!secret) {
      throw new HttpException(401, 'Identity verification is not set up for this messenger', ErrorCode.UNAUTHORIZED);
    }
    const claims = MessengerSessionService.verifyUserToken(userToken, secret);

    const contact = await ContactService.identify(
      projectId,
      claims.sub,
      claims.name ? {name: claims.name} : undefined,
      undefined,
      claims.email,
      undefined,
      false,
    );

    const identity = await prisma.contactIdentity.findUnique({
      where: {projectId_type_value: {projectId, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: visitorId}},
      select: {contact: true},
    });
    const lead = identity?.contact;
    if (lead && lead.id !== contact.id && lead.deletedAt === null) {
      /* A lead with an email, external id or tags is someone's contact, perhaps another person who
      used this browser: it is left alone, and the verified session doesn't see its chats. */
      await this.repointLead(lead, contact.id).catch(error => {
        if (!(error instanceof ConflictError)) {
          throw error;
        }
      });
    }
    return contact;
  }

  /**
   * The visitor's contact is whatever their anonymous id currently points at. A first message
   * creates a lead: unsubscribed, because chatting is not consent to marketing.
   */
  public static async resolveVisitorContact(session: MessengerSession): Promise<string> {
    if (session.verified && session.contactId) {
      return (await this.currentContact(session)).id;
    }
    const identityKey = this.identityKey(session);
    const existing = await prisma.contactIdentity.findUnique({
      where: {projectId_type_value: identityKey},
      select: {contactId: true, contact: {select: {deletedAt: true}}},
    });
    if (existing && existing.contact.deletedAt === null) {
      return existing.contactId;
    }

    const lead = await prisma.contact.create({
      data: {projectId: session.projectId, email: null, subscribed: false, data: Prisma.JsonNull},
    });

    /* Two first messages can race. The identity is claimed conditionally, so exactly one lead wins
    and the loser is discarded rather than left behind as an orphan. */
    let claimed: boolean;
    if (existing) {
      const {count} = await prisma.contactIdentity.updateMany({
        where: {...identityKey, contactId: existing.contactId},
        data: {contactId: lead.id, lastSeenAt: new Date()},
      });
      claimed = count === 1;
    } else {
      try {
        await prisma.contactIdentity.create({data: {...identityKey, contactId: lead.id}});
        claimed = true;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        claimed = false;
      }
    }
    if (claimed) {
      return lead.id;
    }

    await prisma.contact.delete({where: {id: lead.id}});
    const winner = await prisma.contactIdentity.findUniqueOrThrow({
      where: {projectId_type_value: identityKey},
      select: {contactId: true},
    });
    return winner.contactId;
  }

  /** Whether the visitor has given an email. Deliberately not the address itself. */
  public static async hasEmail(projectId: string, visitorId: string): Promise<boolean> {
    const identity = await prisma.contactIdentity.findUnique({
      where: {projectId_type_value: {projectId, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: visitorId}},
      select: {contact: {select: {email: true, deletedAt: true}}},
    });
    return Boolean(identity?.contact.email && identity.contact.deletedAt === null);
  }

  public static async captureEmail(
    session: MessengerSession,
    input: {email: string; subscribe: boolean; conversationId: string},
  ): Promise<MessengerEmailResponse> {
    const conversation = await prisma.conversation.findFirst({
      where: {id: input.conversationId, ...this.conversationScope(session)},
      select: {id: true},
    });
    if (!conversation) {
      throw new NotFound('Conversation', input.conversationId);
    }

    const email = ContactService.normalizeEmail(input.email);
    const current = await this.currentContact(session);

    if (current.email !== null) {
      if (current.email !== email) {
        throw new ConflictError('An email address has already been given for this conversation');
      }
      if (input.subscribe && !current.subscribed) {
        await ContactService.subscribe(current.id);
      }
      return this.reissue(session, current.id);
    }

    const contactId = await this.attachEmail(current, email, input.subscribe);
    await EventService.trackEvent(session.projectId, EMAIL_CAPTURED_EVENT, contactId, undefined, {
      conversationId: conversation.id,
    });
    await RealtimeHub.publish(Keys.Realtime.project(session.projectId), {
      type: 'conversation',
      conversationId: conversation.id,
    });
    return this.reissue(session, contactId);
  }

  private static async currentContact(session: MessengerSession): Promise<Contact> {
    const identity =
      session.verified && session.contactId
        ? null
        : await prisma.contactIdentity.findUnique({
            where: {projectId_type_value: this.identityKey(session)},
            select: {contact: true},
          });
    /* Anonymizing a contact drops its identities, so a session whose identity is gone was erased. */
    const contact =
      identity?.contact ??
      (session.contactId ? await prisma.contact.findUnique({where: {id: session.contactId}}) : null);
    if (!contact || contact.deletedAt !== null) {
      throw new ConflictError('This conversation has been erased and can no longer take an email address');
    }
    return contact;
  }

  /** Returns the id of the contact that carries the email afterwards. */
  private static async attachEmail(lead: Contact, email: string, subscribe: boolean): Promise<string> {
    const existing = await ContactService.findByEmail(lead.projectId, email);
    if (!existing) {
      try {
        await prisma.contact.update({where: {id: lead.id}, data: {email}});
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        return this.attachEmail(lead, email, subscribe);
      }
      if (subscribe) {
        await ContactService.subscribe(lead.id);
      }
      return lead.id;
    }

    if (existing.deletedAt !== null) {
      throw new ConflictError('This email address can no longer be used');
    }
    await this.repointLead(lead, existing.id);
    if (subscribe && !existing.subscribed) {
      await ContactService.subscribe(existing.id);
    }
    return existing.id;
  }

  /* Only a bare messenger lead is folded into another contact, so this never turns into a general
  contact merge. The lead row is locked first: a concurrent first message inserting a conversation
  for it waits, instead of committing a row the delete would then cascade away. */
  private static async repointLead(lead: Contact, targetId: string): Promise<void> {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${lead.id} FOR UPDATE`;
      const [fresh, tags] = await Promise.all([
        tx.contact.findUnique({where: {id: lead.id}, select: {externalId: true, email: true}}),
        tx.contactTag.count({where: {contactId: lead.id}}),
      ]);
      if (!fresh || fresh.email !== null || fresh.externalId !== null || tags > 0) {
        throw new ConflictError('This visitor cannot be matched to an existing contact');
      }

      await tx.conversation.updateMany({where: {contactId: lead.id}, data: {contactId: targetId}});
      await tx.contactIdentity.updateMany({where: {contactId: lead.id}, data: {contactId: targetId}});
      await tx.event.updateMany({where: {contactId: lead.id}, data: {contactId: targetId}});
      await tx.workflowExecution.updateMany({where: {contactId: lead.id}, data: {contactId: targetId}});
      await tx.contact.delete({where: {id: lead.id}});
    });
  }

  private static reissue(session: MessengerSession, contactId: string): MessengerEmailResponse {
    const {token, expiresAt} = MessengerSessionService.sign({...session, contactId});
    return {token, expiresAt: expiresAt.toISOString()};
  }

  private static identityKey(session: MessengerSession) {
    return {projectId: session.projectId, type: CONTACT_IDENTITY_TYPES.ANONYMOUS_ID, value: session.visitorId};
  }
}
