import {z} from 'zod';

/**
 * The `ContactIdentity.type` vocabulary.
 *
 * `type` is a plain string column, not a Prisma enum (see docs/issues/TECH-STRATEGY.md, Finding
 * 6): adding an enum value is an `ALTER TYPE` migration, and the contact-identities acceptance
 * criterion requires the vocabulary to grow without one. Adding `push_token` later is a one-line
 * change here -- append the constant, extend the array below, and CONTACT_IDENTITY_TYPE_ENUM
 * picks it up automatically. No DDL.
 */
export const CONTACT_IDENTITY_TYPES = {
  // An anonymous visitor identifier issued before a person is known by email or external id
  // (e.g. a first-party cookie set on a web guest).
  ANONYMOUS_ID: 'anonymous_id',
  // A third-party analytics tool's distinct id for the same person (e.g. a product-analytics
  // library's device/session id), so that tool's timeline can be joined back to a contact.
  ANALYTICS_DISTINCT_ID: 'analytics_distinct_id',
} as const;

/** All recognised identity types, for the Zod enum and any `type` allow-list check. */
export const CONTACT_IDENTITY_TYPE_VALUES = [
  CONTACT_IDENTITY_TYPES.ANONYMOUS_ID,
  CONTACT_IDENTITY_TYPES.ANALYTICS_DISTINCT_ID,
] as const;

export type ContactIdentityType = (typeof CONTACT_IDENTITY_TYPE_VALUES)[number];

export const CONTACT_IDENTITY_TYPE_ENUM = z.enum(CONTACT_IDENTITY_TYPE_VALUES);
