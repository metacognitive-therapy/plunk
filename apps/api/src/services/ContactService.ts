import {type Contact, Prisma} from '@plunk/db';
import type {CursorPaginatedResponse, FilterCondition, FilterGroup} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import {CONTACT_IDENTITY_TYPE_ENUM} from '@plunk/shared';
import signale from 'signale';

import {mailableContactWhere} from '../database/contact-filters.js';
import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {EventService} from './EventService.js';
import {TagService} from './TagService.js';

/** Shape returned for a contact's recorded identities -- see {@link ContactService.get}. */
export interface ContactIdentitySummary {
  id: string;
  type: string;
  value: string;
  lastSeenAt: Date;
  createdAt: Date;
}

export class ContactService {
  /**
   * Normalize an email address for storage and lookup.
   *
   * Emails are stored lowercased and trimmed so that the find-or-create path
   * (`upsert`/`findByEmail`) and the `(projectId, email)` unique constraint
   * treat case-variant addresses as the same contact. In practice every major
   * mailbox provider delivers `User@x.com` and `user@x.com` to the same inbox,
   * so treating them as one person matches how recipients actually experience
   * email and prevents duplicate, segment-less contacts. Mirrors the `User`
   * model, which already lowercases on write.
   */
  public static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Get all contacts for a project with cursor-based pagination
   * Uses cursor pagination for better performance with large datasets
   */
  public static async list(
    projectId: string,
    limit = 20,
    cursor?: string,
    search?: string,
    options?: {
      /** Filter by subscription state. Backed by the `(projectId, subscribed)` index. */
      subscribed?: boolean;
      /** Sortable columns. `email` is covered by the `(projectId, email)` unique index. */
      sort?: 'email' | 'createdAt';
      dir?: 'asc' | 'desc';
      /** Match contacts tagged with ANY of these tag ids. */
      tagIds?: string[];
      /**
       * Exact (case-sensitive) match on `externalId` -- the caller-supplied id, not a
       * generated one, so unlike `email` it is never case-normalized. Distinct from `search`,
       * which does a substring match across both fields: this is for "show me exactly this
       * contact" (docs/issues/03-track-by-external-id.md), driven from the dashboard's
       * external-id filter.
       */
      externalId?: string;
    },
  ): Promise<CursorPaginatedResponse<Contact & {tags: {id: string; name: string}[]}>> {
    const where: Prisma.ContactWhereInput = {
      projectId,
      // `search` matches BOTH email and externalId (substring, case-insensitive) so a
      // contact can be looked up in the dashboard by whichever identifier the operator has
      // on hand, without needing a second search box.
      ...(search
        ? {
            OR: [
              {email: {contains: search, mode: 'insensitive' as const}},
              {externalId: {contains: search, mode: 'insensitive' as const}},
            ],
          }
        : {}),
      ...(options?.subscribed !== undefined ? {subscribed: options.subscribed} : {}),
      ...(options?.tagIds && options.tagIds.length > 0
        ? {contactTags: {some: {tagId: {in: options.tagIds}}}}
        : {}),
      ...(options?.externalId ? {externalId: options.externalId} : {}),
    };

    // The chosen sort column leads; `id` is always the stable tiebreaker the
    // cursor (`{id}`) keys off, so keyset pagination stays correct under any
    // sort (createdAt is non-unique, hence the tiebreaker; email is unique per
    // project but kept consistent for the same cursor mechanics). Defaults to
    // newest-first, matching the previous behaviour.
    const dir: 'asc' | 'desc' = options?.dir === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.ContactOrderByWithRelationInput[] =
      options?.sort === 'email' ? [{email: dir}, {id: 'desc'}] : [{createdAt: dir}, {id: 'desc'}];

    // Fetch one extra to determine if there are more results.
    const contacts = await prisma.contact.findMany({
      where,
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? {id: cursor} : undefined,
      orderBy,
    });

    const hasMore = contacts.length > limit;
    const results = hasMore ? contacts.slice(0, -1) : contacts;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    // Get total count only on first page for better performance. `mailable`/`leads` split it so
    // the dashboard headline reads as correct-and-filtered rather than wrong (see
    // contact-filters.ts and the `contacts_mailable_idx`/`contacts_leads_idx` partial indexes
    // that back these two counts).
    //
    // `leads` counts contacts with no email specifically -- NOT "everything that isn't
    // mailable". An unsubscribed contact who still has an email is neither mailable nor a lead;
    // conflating the two would make the headline math wrong the moment someone unsubscribes.
    const total = !cursor ? await prisma.contact.count({where}) : 0;
    const mailable = !cursor ? await prisma.contact.count({where: {...where, ...mailableContactWhere()}}) : undefined;
    // Anonymized contacts have a null email too, but they aren't leads -- a lead is someone who
    // hasn't given an email yet, not someone whose record was erased. Excluding `deletedAt` keeps
    // them out of both counts rather than phantom-appearing as prospects.
    const leads = !cursor ? await prisma.contact.count({where: {...where, email: null, deletedAt: null}}) : undefined;

    // Batch-fetch tags for the page in one query rather than per-contact, to
    // avoid N+1s.
    const contactIds = results.map(c => c.id);
    const memberships =
      contactIds.length > 0
        ? await prisma.contactTag.findMany({
            where: {contactId: {in: contactIds}},
            select: {contactId: true, tag: {select: {id: true, name: true}}},
          })
        : [];
    const tagsByContact = new Map<string, {id: string; name: string}[]>();
    for (const membership of memberships) {
      const existing = tagsByContact.get(membership.contactId);
      if (existing) existing.push(membership.tag);
      else tagsByContact.set(membership.contactId, [membership.tag]);
    }

    return {
      data: results.map(c => ({...c, tags: tagsByContact.get(c.id) ?? []})),
      total,
      mailable,
      leads,
      cursor: nextCursor,
      hasMore,
    };
  }

  /**
   * Get a single contact by ID, including its current tags (id + name - bound
   * by id, so a later rename doesn't require the caller to refetch) and its recorded
   * identities (most recently seen first), so the contact detail page can show which
   * person a record refers to alongside the external id.
   */
  public static async get(
    projectId: string,
    contactId: string,
  ): Promise<Contact & {tags: {id: string; name: string}[]; identities: ContactIdentitySummary[]}> {
    const contact = await prisma.contact.findFirst({
      where: {
        id: contactId,
        projectId,
      },
      include: {
        contactTags: {
          include: {tag: {select: {id: true, name: true}}},
        },
        identities: {
          select: {id: true, type: true, value: true, lastSeenAt: true, createdAt: true},
          orderBy: {lastSeenAt: 'desc'},
        },
      },
    });

    if (!contact) {
      throw new HttpException(404, 'Contact not found');
    }

    const {contactTags, identities, ...rest} = contact;
    return {...rest, tags: contactTags.map(ct => ct.tag), identities};
  }

  /**
   * Record (or re-point) a namespaced identity against a contact -- e.g. "this anonymous_id was
   * just seen on this contact". Upserts on the `(projectId, type, value)` unique constraint:
   *
   * - Unseen value -> a new identity row is created against `contactId`.
   * - Already recorded, on ANY contact -> the row is RE-POINTED to `contactId` and `lastSeenAt`
   *   is refreshed. This is the normal case, not an anomaly: an anonymous id first seen on a lead
   *   legitimately moves to the contact it later resolves to. It re-points the identity only --
   *   it does NOT merge the two contacts, which is out of scope for this slice (see
   *   docs/issues/TECH-STRATEGY.md, Finding 6).
   *
   * Because this always upserts, the unique constraint never throws P2002 in normal operation.
   *
   * Nothing in this codebase calls this yet -- wiring it into identify/track/ingestion is out of
   * scope for this slice.
   */
  public static async recordIdentity(
    projectId: string,
    contactId: string,
    type: string,
    value: string,
  ): Promise<ContactIdentitySummary> {
    const parsedType = CONTACT_IDENTITY_TYPE_ENUM.safeParse(type);
    if (!parsedType.success) {
      throw new HttpException(
        400,
        `Unknown identity type "${type}". Must be one of: ${CONTACT_IDENTITY_TYPE_ENUM.options.join(', ')}`,
      );
    }

    const contact = await prisma.contact.findFirst({
      where: {id: contactId, projectId},
      select: {deletedAt: true},
    });

    if (!contact) {
      throw new HttpException(404, 'Contact not found');
    }

    // Mirrors the identify/update guard: an anonymized contact must never regain identifying
    // value, and a live identity re-pointed onto it would be exactly that.
    if (contact.deletedAt != null) {
      throw new HttpException(409, `Contact "${contactId}" has been anonymized and can no longer record identities`);
    }

    const identity = await prisma.contactIdentity.upsert({
      where: {projectId_type_value: {projectId, type: parsedType.data, value}},
      create: {projectId, contactId, type: parsedType.data, value},
      update: {contactId, lastSeenAt: new Date()},
      select: {id: true, type: true, value: true, lastSeenAt: true, createdAt: true},
    });

    return identity;
  }

  /**
   * Bulk-check which emails exist in the project — single query, safe for up to 500 addresses.
   */
  public static async lookup(
    projectId: string,
    emails: string[],
  ): Promise<{found: string[]; notFound: string[]}> {
    // Emails are stored normalized, so an exact `in` match uses the
    // `(projectId, email)` btree index instead of a full scan via ILIKE.
    const normalized = emails.map(e => this.normalizeEmail(e));
    const rows = await prisma.contact.findMany({
      where: {projectId, email: {in: normalized}},
      select: {email: true},
    });
    const foundSet = new Set(rows.map(r => r.email));
    // Return the caller's original strings, partitioned by normalized match.
    const found = emails.filter(e => foundSet.has(this.normalizeEmail(e)));
    const notFound = emails.filter(e => !foundSet.has(this.normalizeEmail(e)));
    return {found, notFound};
  }

  /**
   * Find a contact by email (returns null if not found)
   */
  public static async findByEmail(projectId: string, email: string): Promise<Contact | null> {
    return prisma.contact.findFirst({
      where: {
        projectId,
        email: this.normalizeEmail(email),
      },
    });
  }

  /**
   * Find a contact by its project-scoped external id (returns null if not found).
   *
   * Read-only, deliberately -- this is the resolver behind the /v1/track externalId path
   * (docs/issues/03-track-by-external-id.md), which must NEVER create a contact on this
   * path. The public key that authorises track carries no origin restriction, so "resolve
   * only, never create" is what stops a leaked key from being used to conjure a contact for
   * an email address of the caller's choosing and then mail it. Callers that get `null` back
   * must surface a distinguishable not-found, not fall through to creation.
   */
  public static async findByExternalId(projectId: string, externalId: string): Promise<Contact | null> {
    return prisma.contact.findFirst({
      where: {
        projectId,
        externalId,
      },
    });
  }

  /**
   * Create a new contact
   * Uses unique constraint violation to check for duplicates (more efficient)
   */
  public static async create(
    projectId: string,
    data: {email: string; data?: Prisma.JsonValue; subscribed?: boolean},
  ): Promise<Contact> {
    try {
      return await prisma.contact.create({
        data: {
          projectId,
          email: this.normalizeEmail(data.email),
          data: data.data ?? Prisma.JsonNull,
          subscribed: data.subscribed ?? true,
        },
      });
    } catch (error) {
      // Check if this is a unique constraint violation (P2002)
      if (error instanceof Error && 'code' in error && error.code === 'P2002') {
        throw new HttpException(409, 'Contact with this email already exists in this project');
      }
      throw error;
    }
  }

  /**
   * Update a contact
   * Uses unique constraint violation to check for duplicates (more efficient)
   */
  /**
   * Merge an incoming partial data object into existing contact data.
   * - `null` value on a key deletes that key
   * - empty strings are ignored
   * - reserved/system-generated keys are silently filtered
   * - `{value, persistent: false}` entries are skipped (non-persistent)
   */
  private static mergeContactData(
    existing: Prisma.JsonValue | null,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? {...(existing as Record<string, unknown>)} : {};

    const reservedFields = ['plunk_id', 'plunk_email', 'id', 'email', 'unsubscribeUrl', 'subscribeUrl', 'manageUrl'];

    for (const [key, value] of Object.entries(incoming)) {
      if (reservedFields.includes(key)) continue;
      if (value === '') continue;
      if (value === null) {
        delete merged[key];
        continue;
      }
      if (key === 'locale' && typeof value !== 'string') {
        throw new HttpException(400, 'Locale must be a string');
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        'value' in value &&
        'persistent' in value &&
        (value as {persistent: unknown}).persistent === false
      ) {
        continue;
      }
      merged[key] = value;
    }

    return merged;
  }

  public static async update(
    projectId: string,
    contactId: string,
    data: {email?: string; data?: Prisma.JsonValue; subscribed?: boolean},
  ): Promise<Contact> {
    // First verify contact exists and belongs to project
    const existing = await this.get(projectId, contactId);

    // Mirror the identify() guard: an anonymized contact must never regain an email or
    // attributes through a plain update, or a PATCH would silently undo anonymize. Subscription
    // changes (e.g. the MCP unsubscribe tool, which PATCHes {subscribed}) are still allowed --
    // they don't resurrect anything anonymize erased.
    if (existing.deletedAt != null && (data.email !== undefined || data.data !== undefined)) {
      throw new HttpException(409, `Contact "${contactId}" has been anonymized and can no longer be updated`);
    }

    const updateData: Prisma.ContactUpdateInput = {};

    if (data.email !== undefined) {
      updateData.email = ContactService.normalizeEmail(data.email);
    }
    if (data.data !== undefined) {
      if (data.data === null) {
        updateData.data = Prisma.JsonNull;
      } else if (typeof data.data === 'object' && !Array.isArray(data.data)) {
        const merged = ContactService.mergeContactData(existing.data, data.data as Record<string, unknown>);
        updateData.data = Object.keys(merged).length > 0 ? toPrismaJson(merged) : Prisma.JsonNull;
      } else {
        throw new HttpException(400, 'data must be an object');
      }
    }
    if (data.subscribed !== undefined) {
      updateData.subscribed = data.subscribed;
    }

    // Track subscription status change
    const isSubscriptionChanging = data.subscribed !== undefined && existing.subscribed !== data.subscribed;
    const wasSubscribed = existing.subscribed;

    try {
      const updated = await prisma.contact.update({
        where: {id: contactId},
        data: updateData,
      });

      // Track subscription event if status changed
      if (isSubscriptionChanging) {
        if (data.subscribed && !wasSubscribed) {
          await EventService.trackEvent(projectId, 'contact.subscribed', contactId);
        } else if (!data.subscribed && wasSubscribed) {
          await EventService.trackEvent(projectId, 'contact.unsubscribed', contactId);
        }
      }

      return updated;
    } catch (error) {
      // Check if this is a unique constraint violation (P2002)
      if (error instanceof Error && 'code' in error && error.code === 'P2002') {
        throw new HttpException(409, 'Contact with this email already exists in this project');
      }
      throw error;
    }
  }

  /**
   * Anonymize a contact in place: null its email, clear its `data` attributes, strip the
   * payload from every event it fired, and set `deletedAt`. The row and its send history
   * (Email rows) are RETAINED -- destroying them would break unsubscribe/manage links already
   * embedded in delivered mail and desync campaign counters, which are derived from Email rows
   * rather than stored redundantly. See docs/issues/07-anonymize-replaces-hard-delete.md.
   *
   * `externalId` is deliberately left untouched: nulling it would make a second
   * anonymize-by-external-id call 404 instead of resolving to the same (already anonymized) row,
   * which is the no-op behaviour anonymization is supposed to have. `identifyAttempt` guards the
   * one place that survival could otherwise be exploited to resurrect the contact.
   *
   * Idempotent: a contact that is already anonymized is returned unchanged rather than
   * re-anonymized or rejected.
   */
  private static async anonymizeContact(contact: Contact): Promise<Contact> {
    if (contact.deletedAt != null) {
      return contact;
    }

    const [anonymized] = await prisma.$transaction([
      prisma.contact.update({
        where: {id: contact.id},
        data: {
          email: null,
          data: Prisma.JsonNull,
          deletedAt: new Date(),
        },
      }),
      prisma.event.updateMany({
        where: {contactId: contact.id},
        data: {data: Prisma.JsonNull},
      }),
      // Drop every identity outright -- a live anonymous_id/analytics_distinct_id on an
      // "anonymized" record is exactly the identifying-value leak this criterion forbids.
      prisma.contactIdentity.deleteMany({
        where: {contactId: contact.id},
      }),
    ]);

    return anonymized;
  }

  /**
   * Delete a contact.
   *
   * This anonymizes rather than destroys the row -- see {@link anonymizeContact}. There is no
   * flag or escape hatch back to a hard delete; every entry point (dashboard, API, MCP tool,
   * bulk equivalents) resolves here or to {@link bulkDelete}.
   */
  public static async delete(projectId: string, contactId: string): Promise<void> {
    // First verify contact exists and belongs to project
    const contact = await this.get(projectId, contactId);

    await this.anonymizeContact(contact);
  }

  /**
   * Delete (anonymize) a contact addressed by its project-scoped external id rather than its
   * internal id -- see {@link delete} and {@link anonymizeContact}. Lets an integration that only
   * knows the external id issue the erasure request directly.
   */
  public static async anonymizeByExternalId(projectId: string, externalId: string): Promise<void> {
    const contact = await this.findByExternalId(projectId, externalId);

    if (!contact) {
      throw new HttpException(404, 'Contact not found');
    }

    await this.anonymizeContact(contact);
  }

  /**
   * Get contact count for a project
   */
  public static async count(projectId: string): Promise<number> {
    return prisma.contact.count({
      where: {projectId},
    });
  }

  /**
   * Upsert a contact (create or update) with metadata merging
   * Supports persistent and non-persistent data fields
   * Reserved fields: plunk_id, plunk_email
   */
  public static async upsert(
    projectId: string,
    email: string,
    data?: Record<string, unknown>,
    subscribed?: boolean,
    defaultSubscribed: boolean = true,
  ): Promise<Contact> {
    const normalizedEmail = ContactService.normalizeEmail(email);

    // Find existing contact
    const existing = await prisma.contact.findFirst({
      where: {
        projectId,
        email: normalizedEmail,
      },
    });

    const mergedData = ContactService.mergeContactData(existing?.data ?? null, data ?? {});

    if (existing) {
      // Track subscription status change
      const isSubscriptionChanging = subscribed !== undefined && existing.subscribed !== subscribed;
      const wasSubscribed = existing.subscribed;

      try {
        const updated = await prisma.contact.update({
          where: {id: existing.id},
          data: {
            data: Object.keys(mergedData).length > 0 ? toPrismaJson(mergedData) : Prisma.JsonNull,
            ...(subscribed !== undefined ? {subscribed} : {}),
          },
        });

        // Track subscription event if status changed
        if (isSubscriptionChanging) {
          if (subscribed && !wasSubscribed) {
            await EventService.trackEvent(projectId, 'contact.subscribed', updated.id);
          } else if (!subscribed && wasSubscribed) {
            await EventService.trackEvent(projectId, 'contact.unsubscribed', updated.id);
          }
        }

        return updated;
      } catch (error) {
        // Provide helpful error message for database/validation issues
        throw new HttpException(
          500,
          `Failed to update contact: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    } else {
      try {
        return await prisma.contact.create({
          data: {
            projectId,
            email: normalizedEmail,
            data: Object.keys(mergedData).length > 0 ? toPrismaJson(mergedData) : Prisma.JsonNull,
            subscribed: subscribed ?? defaultSubscribed,
          },
        });
      } catch (error) {
        // Provide helpful error message for database/validation issues
        throw new HttpException(
          500,
          `Failed to create contact: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * PUBLIC: Identify a contact by a project-scoped external id, resolving and binding against an
   * email as needed (docs/issues/02-identify-resolution-and-binding.md).
   *
   * This is the ONLY path permitted to write persistent contact attributes (`data`) and the
   * ONLY path permitted to move tags/attributes without going through the normal event-emitting
   * routes -- see `TagService.applyTagsDirect`.
   *
   * Resolution order is external id FIRST, then email:
   * 1. Found by external id -> update that row, including adopting a changed (or first-time)
   *    email onto the SAME row. This is the fix for the email-change defect: nothing about tags,
   *    segment membership, sequence subscriptions, step sends, workflow executions, events, or
   *    send history moves, because it's the same contact id throughout.
   * 2. Not found by external id, found by email, and that contact's `externalId` is null ->
   *    BIND the external id onto it. This is the primary path for every contact already in
   *    Plunk -- there is no backfill, so contacts adopt their external id lazily, here.
   * 3. Not found by external id, found by email, and that contact's `externalId` is a
   *    DIFFERENT non-null value -> REFUSE with a 409. Silently moving a subscription between two
   *    identified people is never correct.
   * 4. Found by neither -> create. Subscription state comes from the request; absent that, the
   *    existing default (subscribed) applies.
   *
   * `upsert`'s find-then-write is not atomic, and neither is this: two concurrent identifies for
   * a project-new email or external id can both miss the initial lookup and then race on the
   * same unique constraint. Rather than surface that race as a 500, a P2002 on either
   * `(projectId, email)` or `(projectId, externalId)` is retried ONCE from a fresh read -- by
   * then the losing writer's row exists, so the retry resolves it as an update instead of
   * colliding again. A `allowRetry`-gated failure means the underlying cause wasn't a fleeting
   * race but a real conflict, so it still surfaces as a 409 rather than a 500.
   */
  public static async identify(
    projectId: string,
    externalId: string,
    data?: Record<string, unknown>,
    subscribed?: boolean,
    email?: string,
    tagNames?: string[],
  ): Promise<Contact> {
    return this.identifyAttempt(projectId, externalId, data, subscribed, email, tagNames, true);
  }

  private static async identifyAttempt(
    projectId: string,
    externalId: string,
    data: Record<string, unknown> | undefined,
    subscribed: boolean | undefined,
    email: string | undefined,
    tagNames: string[] | undefined,
    allowRetry: boolean,
  ): Promise<Contact> {
    // normalizeEmail MUST run on every path accepting an email (TECH-STRATEGY.md non-negotiable)
    // -- identify is no exception, or case-variant addresses fork into duplicate contacts.
    const normalizedEmail = email !== undefined ? ContactService.normalizeEmail(email) : undefined;

    const byExternalId = await prisma.contact.findFirst({where: {projectId, externalId}});

    let target = byExternalId;
    let bindingExternalId = false;

    if (!target && normalizedEmail !== undefined) {
      const byEmail = await prisma.contact.findFirst({where: {projectId, email: normalizedEmail}});
      if (byEmail) {
        if (byEmail.externalId != null && byEmail.externalId !== externalId) {
          // Case 3: refuse. This contact is already identified as someone else.
          throw new HttpException(
            409,
            `Contact with email "${normalizedEmail}" is already identified with a different external ID`,
          );
        }
        // byEmail.externalId is null: bind (case 2).
        target = byEmail;
        bindingExternalId = true;
      }
    }

    // An anonymized contact (deletedAt set) must never regain an email or attributes through
    // identify -- externalId survives anonymization deliberately (so a second anonymize-by-
    // external-id call is a no-op rather than a 404), which means a later identify call for the
    // same external id would otherwise land here and write a fresh email onto an erased row.
    // Refuse rather than resurrect; the caller should identify with a new external id instead.
    if (target?.deletedAt != null) {
      throw new HttpException(409, `Contact with external ID "${externalId}" has been anonymized and can no longer be identified`);
    }

    // A lead (no email on file yet) gaining an email for the first time on this call ->
    // contact.identified fires exactly once, after the write succeeds. A brand-new contact
    // created with an email from the start was never a lead, so it doesn't qualify; nor does a
    // contact that already had a (possibly different) email.
    const isGainingEmail = target != null && target.email == null && normalizedEmail !== undefined;

    const mergedData = ContactService.mergeContactData(target?.data ?? null, data ?? {});

    try {
      let contact: Contact;

      if (target) {
        const wasSubscribed = target.subscribed;
        contact = await prisma.contact.update({
          where: {id: target.id},
          data: {
            ...(bindingExternalId ? {externalId} : {}),
            ...(normalizedEmail !== undefined ? {email: normalizedEmail} : {}),
            data: Object.keys(mergedData).length > 0 ? toPrismaJson(mergedData) : Prisma.JsonNull,
            ...(subscribed !== undefined ? {subscribed} : {}),
          },
        });

        // Track subscription status change, mirroring upsert/update's convention.
        if (subscribed !== undefined && wasSubscribed !== subscribed) {
          await EventService.trackEvent(
            projectId,
            subscribed ? 'contact.subscribed' : 'contact.unsubscribed',
            contact.id,
          );
        }
      } else {
        // Case 4: neither found -- create.
        contact = await prisma.contact.create({
          data: {
            projectId,
            externalId,
            email: normalizedEmail ?? null,
            data: Object.keys(mergedData).length > 0 ? toPrismaJson(mergedData) : Prisma.JsonNull,
            subscribed: subscribed ?? true,
          },
        });
      }

      // Identify-time tag movement writes directly -- bypasses `tag.added` and therefore
      // sequence auto-enrolment. See TagService.applyTagsDirect for why: a converted lead
      // gaining several tags at once must not flood it into every sequence bound to any of
      // them. The contact still becomes eligible for anything its new state (email, subscribed,
      // tags) qualifies it for through the normal eligibility path -- every send chokepoint
      // (campaign audience, sequence sweep) re-evaluates `mailableContactWhere()` at send time,
      // not at identify time.
      if (tagNames && tagNames.length > 0) {
        const tags = await TagService.resolveOrCreateByNames(projectId, tagNames);
        await TagService.applyTagsDirect(
          projectId,
          contact.id,
          tags.map(tag => tag.id),
        );
      }

      if (isGainingEmail) {
        await EventService.trackEvent(projectId, 'contact.identified', contact.id);
      }

      return contact;
    } catch (error) {
      if (allowRetry && error instanceof Error && 'code' in error && error.code === 'P2002') {
        // Concurrent identify raced us on (projectId, email) or (projectId, externalId) --
        // re-read and retry once (TECH-STRATEGY.md finding 4) rather than surfacing a 500.
        return this.identifyAttempt(projectId, externalId, data, subscribed, email, tagNames, false);
      }
      if (error instanceof HttpException) {
        throw error;
      }
      if (error instanceof Error && 'code' in error && error.code === 'P2002') {
        // Retry exhausted: this wasn't a fleeting race, it's a real conflict (e.g. the email or
        // external id now belongs to a different contact than the one we resolved against).
        throw new HttpException(409, 'Contact with this email or external ID already exists in this project');
      }
      throw new HttpException(
        500,
        `Failed to identify contact: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get the full merged data for a contact including non-persistent fields
   * This is useful for template rendering
   */
  public static getMergedData(contact: Contact, temporaryData?: Record<string, unknown>): Record<string, unknown> {
    const mergedData: Record<string, unknown> = {
      plunk_id: contact.id,
      plunk_email: contact.email,
    };

    // Add contact's persistent data
    if (contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)) {
      Object.assign(mergedData, contact.data);
    }

    // Explicitly expose locale as a predefined field (available in templates)
    // This ensures locale is always accessible even if not in contact.data
    if (mergedData.locale === undefined) {
      mergedData.locale = null;
    }

    // Add temporary (non-persistent) data
    if (temporaryData) {
      for (const [key, value] of Object.entries(temporaryData)) {
        // Skip reserved system-generated fields
        const reservedFields = ['plunk_id', 'plunk_email', 'email', 'unsubscribeUrl', 'subscribeUrl', 'manageUrl'];
        if (reservedFields.includes(key)) {
          continue;
        }

        // Handle non-persistent data format: { value: "...", persistent: false }
        if (
          typeof value === 'object' &&
          value !== null &&
          'value' in value &&
          'persistent' in value &&
          value.persistent === false
        ) {
          mergedData[key] = value.value;
        } else {
          mergedData[key] = value;
        }
      }
    }

    return mergedData;
  }

  /**
   * PUBLIC: Get a contact by ID (no project authentication required)
   * This is used for public-facing pages like unsubscribe
   */
  public static async getById(contactId: string): Promise<Contact> {
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
    });

    if (!contact) {
      throw new HttpException(404, 'Contact not found');
    }

    return contact;
  }

  /**
   * Get project by contact ID
   * Used to fetch project settings for public endpoints
   */
  public static async getProjectByContactId(contactId: string): Promise<{language: string} | null> {
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {
        project: {
          select: {
            language: true,
          },
        },
      },
    });

    return contact?.project || null;
  }

  /**
   * Resolve the email a recipient acted from, as claimed by the `e` parameter on
   * an unsubscribe or manage link.
   *
   * The claim is attacker-controlled — the links are public and unauthenticated —
   * so it is only trusted after confirming the email belongs to this contact.
   * A claim that does not check out is dropped rather than rejected: the
   * subscription change itself is governed by the contact id in the path and
   * must still go through, so a bad `e` costs attribution, not the opt-out.
   */
  private static async resolveSourceEmail(
    contactId: string,
    emailId?: string,
  ): Promise<{id: string; campaignId: string | null; suppressed: boolean} | undefined> {
    if (!emailId) {
      return undefined;
    }

    const email = await prisma.email.findUnique({
      where: {id: emailId},
      select: {id: true, contactId: true, campaignId: true, bouncedAt: true, complainedAt: true},
    });

    if (email?.contactId !== contactId) {
      return undefined;
    }

    return {
      id: email.id,
      campaignId: email.campaignId,
      suppressed: email.bouncedAt !== null || email.complainedAt !== null,
    };
  }

  /**
   * Add one to a campaign's unsubscribe count.
   *
   * Never allowed to fail the opt-out that triggered it: a stats counter is not
   * worth a 5xx on a public unsubscribe endpoint, which would leave a mailbox
   * provider retrying a request that already took effect. Campaign stats
   * recompute from the events on read, so a dropped increment self-heals.
   */
  private static async countCampaignUnsubscribe(campaignId: string): Promise<void> {
    try {
      await prisma.campaign.update({
        where: {id: campaignId},
        data: {unsubscribedCount: {increment: 1}},
      });
    } catch (error) {
      signale.warn(`[CONTACT] Failed to increment unsubscribe count for campaign ${campaignId}:`, error);
    }
  }

  /**
   * PUBLIC: Subscribe a contact
   *
   * @param source - Optional originating email, for attributing the change in
   *                 the activity feed. See {@link resolveSourceEmail}.
   */
  public static async subscribe(contactId: string, source?: {emailId?: string}): Promise<Contact> {
    const sourceEmail = await this.resolveSourceEmail(contactId, source?.emailId);

    const contact = await prisma.contact.update({
      where: {id: contactId},
      data: {subscribed: true},
    });

    // Track subscription event
    await EventService.trackEvent(contact.projectId, 'contact.subscribed', contactId, sourceEmail?.id);

    return contact;
  }

  /**
   * PUBLIC: Unsubscribe a contact
   *
   * @param source - Optional originating email, for attributing the change in
   *                 the activity feed and counting it against the campaign that
   *                 prompted it. See {@link resolveSourceEmail}.
   */
  public static async unsubscribe(contactId: string, source?: {emailId?: string}): Promise<Contact> {
    const sourceEmail = await this.resolveSourceEmail(contactId, source?.emailId);

    const contact = await prisma.contact.update({
      where: {id: contactId},
      data: {subscribed: false},
    });

    // Track unsubscription event
    await EventService.trackEvent(contact.projectId, 'contact.unsubscribed', contactId, sourceEmail?.id);

    // Count it against the campaign the recipient opted out from. Suppressed
    // emails are skipped: a bounce or complaint unsubscribes the contact too,
    // and `bouncedCount` already reports those.
    if (sourceEmail?.campaignId && !sourceEmail.suppressed) {
      await this.countCampaignUnsubscribe(sourceEmail.campaignId);
    }

    return contact;
  }

  /**
   * Get all available contact fields for a project
   * Returns both standard fields and custom fields from the data JSON column
   * Now includes type information inferred from actual data
   *
   * @param projectId - The project ID to filter contacts
   * @returns Array of field objects with name and type
   */
  public static async getAvailableFields(
    projectId: string,
  ): Promise<Array<{field: string; type: 'string' | 'number' | 'boolean' | 'date'; coverage: number}>> {
    // Get total contact count for coverage calculation
    const totalContacts = await prisma.contact.count({
      where: {projectId},
    });

    // Email is no longer guaranteed on every contact -- a lead has none -- so its coverage is
    // measured like a custom field's rather than assumed 100%. Every other standard field is
    // still set on every row.
    const contactsWithEmail = await prisma.contact.count({
      where: {projectId, email: {not: null}},
    });
    const emailCoverage = totalContacts > 0 ? Math.round((contactsWithEmail / totalContacts) * 100) : 0;

    const standardFields = [
      {field: 'email', type: 'string' as const, coverage: emailCoverage},
      {field: 'subscribed', type: 'boolean' as const, coverage: 100},
      {field: 'createdAt', type: 'date' as const, coverage: 100},
      {field: 'updatedAt', type: 'date' as const, coverage: 100},
    ];

    // Get custom fields from the data JSON column with type inference and coverage
    // Use raw SQL to extract all keys, sample values, and contact counts from the JSON data column
    const result = await prisma.$queryRaw<
      Array<{key: string; sample_value: string; json_type: string; contact_count: bigint}>
    >`
      WITH field_keys AS (
        SELECT DISTINCT jsonb_object_keys(data) as key
        FROM contacts
        WHERE
          "projectId" = ${projectId}
          AND data IS NOT NULL
          AND jsonb_typeof(data) = 'object'
      ),
      field_samples AS (
        SELECT
          fk.key,
          jsonb_typeof(c.data->fk.key) as json_type,
          (c.data->>fk.key) as sample_value
        FROM field_keys fk
        CROSS JOIN LATERAL (
          SELECT data
          FROM contacts
          WHERE
            "projectId" = ${projectId}
            AND data ? fk.key
            AND data->fk.key IS NOT NULL
          LIMIT 1
        ) c
      ),
      field_counts AS (
        SELECT
          fk.key,
          COUNT(*) as contact_count
        FROM field_keys fk
        JOIN contacts c ON c."projectId" = ${projectId}
          AND c.data ? fk.key
          AND c.data->fk.key IS NOT NULL
        GROUP BY fk.key
      )
      SELECT
        fs.key,
        fs.sample_value,
        fs.json_type,
        fc.contact_count
      FROM field_samples fs
      JOIN field_counts fc ON fc.key = fs.key
    `;

    // Infer types from JSON types and sample values, calculate coverage
    const customFields = result.map(row => {
      let type: 'string' | 'number' | 'boolean' | 'date' = 'string';

      // PostgreSQL jsonb_typeof returns: "object", "array", "string", "number", "boolean", "null"
      if (row.json_type === 'boolean') {
        type = 'boolean';
      } else if (row.json_type === 'number') {
        type = 'number';
      } else if (row.json_type === 'string' && row.sample_value) {
        // Try to detect dates (ISO 8601 format)
        const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;
        if (dateRegex.test(row.sample_value)) {
          type = 'date';
        }
      }

      // Calculate coverage percentage
      const contactCount = Number(row.contact_count);
      const coverage = totalContacts > 0 ? Math.round((contactCount / totalContacts) * 100) : 0;

      return {
        field: `data.${row.key}`,
        type,
        coverage,
      };
    });

    return [...standardFields, ...customFields].sort((a, b) => a.field.localeCompare(b.field));
  }

  /**
   * Get unique values for a contact field
   * Optimized for large datasets (1M+ contacts) - limits results and uses efficient queries
   *
   * @param projectId - The project ID to filter contacts
   * @param field - The field path (e.g., "subscribed", "email", "data.plan", "data.firstName")
   * @param limit - Maximum number of unique values to return (default: 100)
   * @returns Array of unique values, sorted alphabetically
   */
  public static async getUniqueFieldValues(
    projectId: string,
    field: string,
    limit = 100,
  ): Promise<Array<string | number | boolean>> {
    if (field === 'subscribed') {
      // Boolean field - return both possible values
      return [true, false];
    }

    if (field === 'email') {
      // Email is not useful for dropdowns, return empty
      return [];
    }

    // Handle JSON data fields (e.g., "data.plan" or just "plan")
    const jsonField = field.startsWith('data.') ? field.substring(5) : field;

    // Use raw SQL for performance with large datasets
    // Extract unique values from the JSON field using PostgreSQL's JSON operators
    const result = await prisma.$queryRaw<Array<{value: unknown}>>`
      SELECT DISTINCT
        data->>${jsonField} as value
      FROM contacts
      WHERE
        "projectId" = ${projectId}
        AND data ? ${jsonField}
        AND data->>${jsonField} IS NOT NULL
        AND data->>${jsonField} != ''
      ORDER BY value
      LIMIT ${limit}
    `;

    // Parse and return values, handling different data types
    return result
      .map(row => {
        const value = String(row.value);

        // Try to parse as boolean
        if (value === 'true') return true;
        if (value === 'false') return false;

        // Try to parse as number
        const numValue = Number(value);
        if (!isNaN(numValue) && value.trim() !== '') {
          return numValue;
        }

        // Return as string
        return value;
      })
      .filter(v => v !== null && v !== undefined);
  }

  /**
   * Check if a contact field is used in any segments or campaigns
   * Returns usage information including which segments/campaigns use the field
   *
   * @param projectId - The project ID
   * @param field - The field to check (e.g., "data.plan", "email", "subscribed")
   * @returns Usage information
   */
  public static async getFieldUsage(
    projectId: string,
    field: string,
  ): Promise<{
    usedInSegments: Array<{id: string; name: string}>;
    usedInCampaigns: Array<{id: string; name: string}>;
    contactCount: number;
    canDelete: boolean;
  }> {
    // Get all segments for the project
    const segments = await prisma.segment.findMany({
      where: {projectId},
      select: {id: true, name: true, condition: true},
    });

    // Check which segments use this field
    const usedInSegments = segments.filter(segment => {
      const condition = segment.condition as FilterCondition | null;
      return this.fieldUsedInCondition(field, condition);
    });

    // For now, we'll check if campaigns use the field in their subject or body
    // This is a simplified check - you might want to enhance this based on your campaign structure
    const usedInCampaigns: Array<{id: string; name: string}> = [];

    // Count contacts that have this field (for data fields)
    let contactCount = 0;
    if (field.startsWith('data.')) {
      const jsonField = field.substring(5);
      const result = await prisma.$queryRaw<Array<{count: bigint}>>`
        SELECT COUNT(*) as count
        FROM contacts
        WHERE
          "projectId" = ${projectId}
          AND data ? ${jsonField}
          AND data->${jsonField} IS NOT NULL
      `;
      contactCount = Number(result[0]?.count || 0);
    } else if (field === 'email') {
      // Unlike the other standard fields, email is not guaranteed on every contact -- a lead has
      // none -- so its usage count is scoped to contacts that actually have one.
      contactCount = await prisma.contact.count({where: {projectId, email: {not: null}}});
    } else if (field === 'subscribed' || field === 'createdAt' || field === 'updatedAt') {
      // These standard fields exist on all contacts
      contactCount = await prisma.contact.count({where: {projectId}});
    }

    const canDelete = usedInSegments.length === 0 && usedInCampaigns.length === 0;

    return {
      usedInSegments: usedInSegments.map(s => ({id: s.id, name: s.name})),
      usedInCampaigns,
      contactCount,
      canDelete,
    };
  }

  /**
   * Delete a custom field from all contacts
   * WARNING: This is destructive and cannot be undone
   * Should only be called after verifying the field is not in use
   *
   * @param projectId - The project ID
   * @param field - The field to delete (must be a data.* field)
   */
  public static async deleteField(projectId: string, field: string): Promise<{deletedFrom: number}> {
    // Only allow deleting custom data fields
    if (!field.startsWith('data.')) {
      throw new HttpException(400, 'Can only delete custom data fields (data.*)');
    }

    // Check if field is in use
    const usage = await this.getFieldUsage(projectId, field);
    if (!usage.canDelete) {
      throw new HttpException(
        400,
        `Cannot delete field: used in ${usage.usedInSegments.length} segment(s) and ${usage.usedInCampaigns.length} campaign(s)`,
      );
    }

    const jsonField = field.substring(5);

    // Delete the field from all contacts using raw SQL
    // PostgreSQL's `-` operator removes a key from a JSON object
    const result = await prisma.$executeRaw`
      UPDATE contacts
      SET data = data - ${jsonField}
      WHERE
        "projectId" = ${projectId}
        AND data ? ${jsonField}
    `;

    return {deletedFrom: result};
  }

  /**
   * Bulk subscribe contacts
   * Updates multiple contacts to subscribed=true in batches.
   * `updated` = contacts flipped from unsubscribed to subscribed.
   * `unchanged` = contacts that were already subscribed (no-op, not a failure).
   */
  public static async bulkSubscribe(
    projectId: string,
    contactIds: string[],
  ): Promise<{updated: number; unchanged: number}> {
    const contacts = await prisma.contact.findMany({
      where: {id: {in: contactIds}, projectId},
      select: {id: true, subscribed: true},
    });

    if (contacts.length === 0) {
      return {updated: 0, unchanged: 0};
    }

    const unsubscribedIds = contacts.filter(c => !c.subscribed).map(c => c.id);
    const unchanged = contacts.length - unsubscribedIds.length;

    if (unsubscribedIds.length === 0) {
      return {updated: 0, unchanged};
    }

    const result = await prisma.contact.updateMany({
      where: {id: {in: unsubscribedIds}, projectId},
      data: {subscribed: true},
    });

    this.trackEventsSequentially(projectId, 'contact.subscribed', unsubscribedIds).catch(error => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[ContactService] Failed to track bulk subscribe events:', error);
      }
    });

    return {updated: result.count, unchanged};
  }

  /**
   * Bulk unsubscribe contacts.
   * `updated` = contacts flipped from subscribed to unsubscribed.
   * `unchanged` = contacts that were already unsubscribed (no-op, not a failure).
   */
  public static async bulkUnsubscribe(
    projectId: string,
    contactIds: string[],
  ): Promise<{updated: number; unchanged: number}> {
    const contacts = await prisma.contact.findMany({
      where: {id: {in: contactIds}, projectId},
      select: {id: true, subscribed: true},
    });

    if (contacts.length === 0) {
      return {updated: 0, unchanged: 0};
    }

    const subscribedIds = contacts.filter(c => c.subscribed).map(c => c.id);
    const unchanged = contacts.length - subscribedIds.length;

    if (subscribedIds.length === 0) {
      return {updated: 0, unchanged};
    }

    const result = await prisma.contact.updateMany({
      where: {id: {in: subscribedIds}, projectId},
      data: {subscribed: false},
    });

    this.trackEventsSequentially(projectId, 'contact.unsubscribed', subscribedIds).catch(error => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[ContactService] Failed to track bulk unsubscribe events:', error);
      }
    });

    return {updated: result.count, unchanged};
  }

  /**
   * Bulk delete (anonymize) contacts -- see {@link anonymizeContact}.
   * `deleted` = contacts newly anonymized.
   * `unchanged` = contacts that were already anonymized (no-op, not a failure), mirroring
   * `bulkSubscribe`/`bulkUnsubscribe`'s convention.
   */
  public static async bulkDelete(projectId: string, contactIds: string[]): Promise<{deleted: number; unchanged: number}> {
    const contacts = await prisma.contact.findMany({
      where: {id: {in: contactIds}, projectId},
      select: {id: true, deletedAt: true},
    });

    if (contacts.length === 0) {
      return {deleted: 0, unchanged: 0};
    }

    const toAnonymizeIds = contacts.filter(c => c.deletedAt == null).map(c => c.id);
    const unchanged = contacts.length - toAnonymizeIds.length;

    if (toAnonymizeIds.length === 0) {
      return {deleted: 0, unchanged};
    }

    const [updateResult] = await prisma.$transaction([
      prisma.contact.updateMany({
        where: {id: {in: toAnonymizeIds}, projectId},
        data: {email: null, data: Prisma.JsonNull, deletedAt: new Date()},
      }),
      prisma.event.updateMany({
        where: {contactId: {in: toAnonymizeIds}},
        data: {data: Prisma.JsonNull},
      }),
      // Same leak as the single-contact path (see anonymizeContact) but via a separate
      // updateMany, not a loop over it -- must be dropped here too or the bulk path leaks
      // identifying values out of an "anonymized" record.
      prisma.contactIdentity.deleteMany({
        where: {contactId: {in: toAnonymizeIds}},
      }),
    ]);

    return {deleted: updateResult.count, unchanged};
  }

  /**
   * Helper: Check if a field is used in a filter condition (recursive)
   */
  private static fieldUsedInCondition(field: string, condition: FilterCondition | null): boolean {
    if (!condition || typeof condition !== 'object') {
      return false;
    }

    // Check groups in the condition
    if (Array.isArray(condition.groups)) {
      for (const group of condition.groups) {
        if (this.fieldUsedInGroup(field, group)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Helper: Check if a field is used in a filter group (recursive)
   */
  private static fieldUsedInGroup(field: string, group: FilterGroup): boolean {
    if (!group || typeof group !== 'object') {
      return false;
    }

    // Check filters in the group
    if (Array.isArray(group.filters)) {
      for (const filter of group.filters) {
        if (filter.field === field) {
          return true;
        }
      }
    }

    // Check nested conditions
    if (group.conditions) {
      return this.fieldUsedInCondition(field, group.conditions);
    }

    return false;
  }

  /**
   * Track events sequentially to avoid database deadlocks
   * Processes events one at a time with error handling
   *
   * @private
   */
  private static async trackEventsSequentially(
    projectId: string,
    eventName: string,
    contactIds: string[],
  ): Promise<void> {
    for (const contactId of contactIds) {
      try {
        await EventService.trackEvent(projectId, eventName, contactId);
      } catch (error) {
        // Log error but continue processing remaining events
        // Suppress logging in test environments to reduce noise from cleanup race conditions
        if (process.env.NODE_ENV !== 'test') {
          console.error(`[ContactService] Failed to track event ${eventName} for contact ${contactId}:`, error);
        }
      }
    }
  }
}
