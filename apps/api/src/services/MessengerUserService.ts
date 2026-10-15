import {prisma} from '../database/prisma.js';
import {ConflictError, ErrorCode, HttpException, NotFound, ValidationError} from '../exceptions/index.js';
import {ContactService} from './ContactService.js';
import {EventService} from './EventService.js';
import type {MessengerSession} from './MessengerSessionService.js';
import {MessengerSettingsService} from './MessengerSettingsService.js';

type AttributeValue = string | number | boolean | null;

export interface MessengerEventInput {
  name: string;
  data?: Record<string, AttributeValue>;
  occurredAt?: Date;
}

/**
 * What a signed-in user's app records about them, in place of Intercom's updateUser and logEvent.
 * Only a verified session may write: its contact was proven by a token the customer's backend
 * signed, so the app ships no secret key and an anonymous visitor can't write to anyone.
 */
export class MessengerUserService {
  /** Only the project's declared attributes, all or nothing, so a typo can't half-apply. */
  public static async updateUser(session: MessengerSession, attributes: Record<string, AttributeValue>): Promise<void> {
    const contact = await this.signedInContact(session);
    const {userAttributes} = await MessengerSettingsService.get(session.projectId);
    const declared = new Set(userAttributes);
    const undeclared = Object.keys(attributes).filter(key => !declared.has(key));
    if (undeclared.length > 0) {
      throw new ValidationError(
        undeclared.map(key => ({
          field: `attributes.${key}`,
          message: `"${key}" is not a declared user attribute`,
          code: 'undeclared_attribute',
          received: key,
        })),
        `Not a declared user attribute: ${undeclared.join(', ')}. Declare it in Settings > Messenger first.`,
      );
    }
    await ContactService.identify(session.projectId, contact.externalId, attributes);
  }

  /* The data stays on the event for workflows and is never merged into the contact's attributes,
  so events can't grow the attribute space past what the project declared. */
  public static async logEvent(session: MessengerSession, input: MessengerEventInput): Promise<void> {
    const contact = await this.signedInContact(session);
    if (EventService.isReservedEvent(input.name)) {
      throw new ValidationError(
        [{field: 'name', message: `"${input.name}" is reserved for system use`, code: 'reserved_event', received: input.name}],
        `Event name "${input.name}" is reserved for system use and cannot be logged`,
      );
    }
    await EventService.trackEvent(session.projectId, input.name, contact.id, undefined, input.data, input.occurredAt);
  }

  private static async signedInContact(session: MessengerSession): Promise<{id: string; externalId: string}> {
    if (!session.verified || !session.contactId) {
      throw new HttpException(403, 'This needs a signed-in user', ErrorCode.FORBIDDEN);
    }
    const contact = await prisma.contact.findFirst({
      where: {id: session.contactId, projectId: session.projectId},
      select: {id: true, externalId: true, deletedAt: true},
    });
    if (!contact) {
      throw new NotFound('Contact');
    }
    if (contact.deletedAt || !contact.externalId) {
      throw new ConflictError('This user has been erased and can no longer be updated');
    }
    return {id: contact.id, externalId: contact.externalId};
  }
}
