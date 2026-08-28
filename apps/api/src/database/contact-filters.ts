import type {Prisma} from '@plunk/db';

/**
 * Fields `isMailableContact` (and friends) read from an already-fetched contact. Callers should
 * widen their `select`/`include` to cover at least these fields. All three are required (not
 * optional) so that widening this list forces every caller's `select` to widen too --
 * `tsc --noEmit` turns a missed chokepoint into a compile error instead of a runtime gap.
 */
export type MailableContactFields = {
  email: string | null;
  subscribed: boolean;
  deletedAt: Date | null;
};

/**
 * One named rule in the mailable-contact predicate.
 *
 * Each rule supplies both shapes it must be expressed in — a Prisma where-fragment for query
 * sites, and a boolean check for the imperative send guards — so the two exports can never
 * drift: a rule whose Prisma shape and boolean shape differ (e.g. `{not: null}` vs `!== null`)
 * still only has one place to change.
 *
 * `scope` marks whether the rule applies to every send path (`universal`) or only to marketing
 * sends (`marketing`). Transactional sends are exempt from `marketing`-scoped rules but never
 * from `universal` ones — see `transactionalMailableContactWhere`/`isTransactionallyMailableContact`
 * below. Today there is only one rule, and it is marketing-scoped, so the two exported predicates
 * are identical; the split exists so a later widening (email presence, anonymization) can add a
 * `universal` rule without every call site re-deriving the transactional exemption by hand.
 */
interface MailableContactCondition {
  name: string;
  scope: 'universal' | 'marketing';
  where: Prisma.ContactWhereInput;
  check(contact: MailableContactFields): boolean;
}

/**
 * The single source of truth for whether a contact may receive marketing email. Every send
 * chokepoint (campaign audience selection, sequence enrolment/send, and the two
 * transactional/workflow send guards) must derive from this list rather than re-declaring a
 * condition, so a future widening of the predicate only has to change one place.
 */
const MAILABLE_CONTACT_CONDITIONS: readonly MailableContactCondition[] = [
  {
    // A contact with no email cannot be mailed by ANY path, including transactional -- you
    // cannot send to an address that does not exist. This is the rule that distinguishes a lead
    // from a mailable contact.
    name: 'email-present',
    scope: 'universal',
    where: {email: {not: null}},
    check: contact => contact.email != null,
  },
  {
    // A soft-deleted/anonymized contact is unmailable everywhere, transactional included -- the
    // record still exists (for referential integrity / historical data) but nothing should be
    // sent to it again.
    name: 'not-deleted',
    scope: 'universal',
    where: {deletedAt: null},
    check: contact => contact.deletedAt == null,
  },
  {
    // Marketing-only: transactional sends are exempt from the subscription flag (but not from
    // the universal rules above).
    name: 'subscribed',
    scope: 'marketing',
    where: {subscribed: true},
    check: contact => contact.subscribed === true,
  },
];

function conditionsInScope(scopes: readonly MailableContactCondition['scope'][]): MailableContactCondition[] {
  return MAILABLE_CONTACT_CONDITIONS.filter(condition => scopes.includes(condition.scope));
}

function whereForScopes(scopes: readonly MailableContactCondition['scope'][]): Prisma.ContactWhereInput {
  const fragments = conditionsInScope(scopes).map(condition => condition.where);
  if (fragments.length === 0) return {};
  if (fragments.length === 1) return fragments[0]!;
  return {AND: fragments};
}

function checkForScopes(
  contact: MailableContactFields | null | undefined,
  scopes: readonly MailableContactCondition['scope'][],
): boolean {
  if (!contact) {
    return false;
  }

  return conditionsInScope(scopes).every(condition => condition.check(contact));
}

/**
 * Prisma where-fragment for query sites (campaign audience selection, sequence enrolment/send).
 * The sequence site nests this under its `contact:` relation filter.
 *
 * Includes every rule — universal and marketing-scoped alike. Marketing send paths (campaigns,
 * sequences) use this.
 */
export function mailableContactWhere(): Prisma.ContactWhereInput {
  return whereForScopes(['universal', 'marketing']);
}

/**
 * Prisma where-fragment for transactional send sites: only `universal` rules apply.
 * Transactional sends are exempt from marketing-only rules (e.g. `subscribed`) but not from
 * universal ones.
 */
export function transactionalMailableContactWhere(): Prisma.ContactWhereInput {
  return whereForScopes(['universal']);
}

/**
 * Boolean predicate over an already-fetched contact, for the imperative send guards (marketing
 * paths). Callers keep their own failure mode (throw, silently skip, etc.) — this only decides.
 */
export function isMailableContact(contact: MailableContactFields | null | undefined): boolean {
  return checkForScopes(contact, ['universal', 'marketing']);
}

/**
 * Boolean predicate for the imperative send guards on transactional paths: only `universal`
 * rules apply.
 */
export function isTransactionallyMailableContact(contact: MailableContactFields | null | undefined): boolean {
  return checkForScopes(contact, ['universal']);
}
