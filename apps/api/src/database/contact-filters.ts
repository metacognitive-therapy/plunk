import type {Prisma} from '@plunk/db';

/**
 * The single source of truth for whether a contact may receive marketing email.
 *
 * Today this means exactly `subscribed === true`. Every send chokepoint (campaign audience
 * selection, sequence enrolment/send, and the two transactional/workflow send guards) must derive
 * from this definition rather than re-declaring the condition, so a future widening of the
 * predicate only has to change one place.
 */
const MAILABLE_CONTACT_CONDITION = {
  subscribed: true,
} as const;

/**
 * Fields `isMailableContact` reads from an already-fetched contact. Callers should widen their
 * `select`/`include` to cover at least these fields.
 */
export type MailableContactFields = {
  subscribed: boolean;
};

/**
 * Prisma where-fragment for query sites (campaign audience selection, sequence enrolment/send).
 * The sequence site nests this under its `contact:` relation filter.
 */
export function mailableContactWhere(): Prisma.ContactWhereInput {
  return {...MAILABLE_CONTACT_CONDITION};
}

/**
 * Boolean predicate over an already-fetched contact, for the imperative send guards. Callers keep
 * their own failure mode (throw, silently skip, etc.) — this only decides.
 */
export function isMailableContact(contact: MailableContactFields | null | undefined): boolean {
  if (!contact) {
    return false;
  }

  return contact.subscribed === MAILABLE_CONTACT_CONDITION.subscribed;
}
