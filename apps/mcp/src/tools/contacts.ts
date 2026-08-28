import * as z from 'zod';

import type {PlunkClient} from '../client.js';

import {errorResult, jsonResult, paginationHint, register, runTool, type ToolContext} from './shared.js';

interface ContactList {
  data: unknown[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

interface Contact {
  id: string;
  // Nullable: a contact with no email is a lead (docs/issues/03-track-by-external-id.md),
  // identified only by its externalId until something identifies it with an email.
  email: string | null;
  subscribed?: boolean;
  externalId?: string | null;
  // Namespaced identifiers recorded against this contact -- anonymous web ids, analytics
  // distinct ids, etc. (docs/issues/08-contact-identities.md). Only present on the single-
  // contact response (plunk_get_contact), not on list pages.
  identities?: {id: string; type: string; value: string; lastSeenAt: string; createdAt: string}[];
}

/** Either identifier accepted by the contact tools. Exactly one is required. */
export const contactRef = {
  id: z.string().optional().describe('The contact ID (a UUID). Use this when you already have it.'),
  email: z
    .string()
    .optional()
    .describe('The contact email address. Resolved to the contact for you — prefer this if the user gave an email.'),
  externalId: z
    .string()
    .optional()
    .describe(
      'The caller-supplied external ID (e.g. your own user id). Resolved to the contact for you — use this for ' +
        'a lead or any contact identified by external id rather than email.',
    ),
};

/**
 * Resolves whichever identifier the model supplied to a contact ID.
 *
 * Agents almost always hold an email or their own external id rather than an internal UUID,
 * but the API only addresses contacts by ID. Doing the resolution here collapses what would
 * otherwise be a search-then-read round trip the model has to know to perform, and removes
 * the chance of it patching whichever row happened to come back first from a substring
 * search.
 *
 * `GET /contacts?search=` is a substring match, so a search for "bo@x.com" also
 * matches "bo@x.com.au". The exact (case-insensitive) match is therefore picked
 * out of the page rather than trusting position. `externalId` is resolved via the exact
 * `?externalId=` filter instead, since it's an opaque caller-supplied id, not an email --
 * there's no "close enough" substring match worth trusting for it.
 */
export async function resolveContact(
  client: PlunkClient,
  {id, email, externalId}: {id?: string; email?: string; externalId?: string},
): Promise<{id: string; label: string} | {error: string}> {
  const provided = [id, email, externalId].filter((value) => value !== undefined).length;
  if (provided > 1) {
    return {error: 'Pass exactly one of id, email, or externalId.'};
  }

  if (id) {
    return {id, label: id};
  }

  if (externalId) {
    const result = await client.request<ContactList>({
      path: '/contacts',
      query: {externalId, limit: 1},
    });
    const match = (result.data as Contact[])[0];
    if (!match) {
      return {error: `No contact found with external ID "${externalId}".`};
    }
    return {id: match.id, label: match.email ?? `external ID ${externalId}`};
  }

  if (!email) {
    return {error: 'One of id, email, or externalId is required.'};
  }

  const normalised = email.trim().toLowerCase();

  const result = await client.request<ContactList>({
    path: '/contacts',
    query: {search: normalised, limit: 100},
  });

  const match = (result.data as Contact[]).find((contact) => contact.email?.toLowerCase() === normalised);

  if (!match) {
    // hasMore means the exact address could still be on a later page; say so
    // rather than reporting a definite "no such contact".
    const caveat = result.hasMore
      ? ' The search returned a full page, so it may exist under a different case or with surrounding whitespace.'
      : '';

    return {error: `No contact found with email "${email}".${caveat}`};
  }

  return {id: match.id, label: match.email ?? match.id};
}

export function registerContactTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_contacts',
    {
      title: 'List contacts',
      description: [
        '**Purpose:** Browse or search the contacts in the Plunk project, with cursor pagination.',
        '',
        '**NOT for:** Looking up one contact whose ID you already have (use `plunk_get_contact`).',
        'Not for counting a campaign audience — create a segment instead.',
        '',
        '**Returns:** A page of contacts (id, email — `null` for a lead with no email yet,',
        'subscribed, externalId, custom data), a `cursor` for the next page, `hasMore`, and',
        '`total`. `total` is only populated on the first page; later pages return 0 to avoid the',
        'recount cost.',
        '',
        '**When to use:**',
        '- The user asks who is on their list, or to find a contact by email or external id',
        '- You need a contact ID before updating, deleting, or tracking an event',
        '',
        '**Key trigger phrases:** "who is subscribed", "find the contact", "look up", "my contacts", "leads"',
      ].join('\n'),
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on the email address OR the external ID.'),
        externalId: z
          .string()
          .optional()
          .describe('Exact match on the external ID. Prefer this over `search` when you have the exact value.'),
        subscribed: z
          .boolean()
          .optional()
          .describe('Filter by subscription state. Omit to return both subscribed and unsubscribed contacts.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Items per page (max 100). Keep this small unless the user asked for a bulk export.'),
        cursor: z.string().optional().describe('Cursor from a previous page. Omit for the first page.'),
        sort: z.enum(['email', 'createdAt']).default('createdAt').describe('Column to sort by.'),
        dir: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({search, externalId, subscribed, limit, cursor, sort, dir}) =>
      runTool(async () => {
        const result = await client.request<ContactList>({
          path: '/contacts',
          query: {search, externalId, subscribed, limit, cursor, sort, dir},
        });

        const summary =
          `Found ${result.data.length} contact(s)` +
          (result.total ? ` of ${result.total} total.` : '.') +
          paginationHint(result.hasMore, result.cursor);

        return jsonResult(summary, result);
      }),
  );

  register(
    ctx,
    'plunk_get_contact',
    {
      title: 'Get contact',
      description: [
        '**Purpose:** Fetch a single contact by ID, email address, or external ID, including all custom data fields.',
        '',
        '**NOT for:** Browsing or searching many contacts — use `plunk_list_contacts`.',
        '',
        '**Returns:** The contact record (id, email — `null` for a lead, subscribed, externalId,',
        'data, timestamps), plus `identities` — namespaced identifiers recorded against this',
        'contact (e.g. an anonymous web id or analytics distinct id), each with the type, value,',
        'and when it was last seen.',
        '',
        '**Pass whichever identifier the user gave you** — you do not need to look the ID up first.',
        'Matching on email is exact and case-insensitive; matching on external ID is exact.',
        'A contact with no email on file is a lead, identified only by its external ID.',
        '',
        '**Key trigger phrases:** "show me this contact", "what data do we have on", "is X subscribed"',
      ].join('\n'),
      inputSchema: z.object(contactRef),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, externalId}) =>
      runTool(async () => {
        const resolved = await resolveContact(client, {id, email, externalId});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const contact = await client.request({path: `/contacts/${encodeURIComponent(resolved.id)}`});
        return jsonResult('Contact:', contact);
      }),
  );

  register(
    ctx,
    'plunk_unsubscribe_contact',
    {
      title: 'Unsubscribe contact',
      description: [
        '**Purpose:** Stop marketing email to a contact, by email address or ID. This is the correct',
        'way to honour an unsubscribe request.',
        '',
        '**NOT for:** Erasing someone — that is `plunk_delete_contact`, and it is almost never what the',
        'user means. Unsubscribing keeps their record and their history, and can be reversed with',
        '`plunk_subscribe_contact`.',
        '',
        '**Returns:** The updated contact, with `subscribed: false`.',
        '',
        '**Note:** Transactional email still reaches unsubscribed contacts. Only marketing email stops.',
        'Unsubscribing a contact who is already unsubscribed is a no-op, not an error.',
        '',
        '**Key trigger phrases:** "unsubscribe them", "opt them out", "take them off the list",',
        '"they asked to stop receiving emails"',
      ].join('\n'),
      inputSchema: z.object(contactRef),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, externalId}) =>
      runTool(async () => {
        const resolved = await resolveContact(client, {id, email, externalId});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const contact = await client.request({
          method: 'PATCH',
          path: `/contacts/${encodeURIComponent(resolved.id)}`,
          body: {subscribed: false},
        });

        return jsonResult(`${resolved.label} is now unsubscribed from marketing email.`, contact);
      }),
  );

  register(
    ctx,
    'plunk_subscribe_contact',
    {
      title: 'Subscribe contact',
      description: [
        '**Purpose:** Re-subscribe an existing contact to marketing email, by email address or ID.',
        '',
        '**NOT for:** Adding someone who is not in the project yet — this fails if the contact does not',
        'exist. Use `plunk_create_contact` to add a new contact, which subscribes them at the same time.',
        'That distinction is deliberate: opting someone in should not silently create a record for an',
        'address nobody has consented on.',
        '',
        '**Returns:** The updated contact, with `subscribed: true`.',
        '',
        '**Only do this when the contact has actually asked to be re-subscribed.** Re-subscribing',
        'someone who opted out is a compliance problem, not a convenience.',
        '',
        '**Key trigger phrases:** "resubscribe them", "opt them back in", "they want emails again"',
      ].join('\n'),
      inputSchema: z.object(contactRef),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, externalId}) =>
      runTool(async () => {
        const resolved = await resolveContact(client, {id, email, externalId});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const contact = await client.request({
          method: 'PATCH',
          path: `/contacts/${encodeURIComponent(resolved.id)}`,
          body: {subscribed: true},
        });

        return jsonResult(`${resolved.label} is now subscribed to marketing email.`, contact);
      }),
  );

  register(
    ctx,
    'plunk_create_contact',
    {
      title: 'Create or update contact',
      description: [
        '**Purpose:** Create a contact, or update it if the email already exists. This is an upsert,',
        'so it is safe to call when you are unsure whether the contact exists.',
        '',
        '**NOT for:** Changing the email address of an existing contact, or removing a data field —',
        'use `plunk_update_contact` for those.',
        '',
        '**Returns:** The created or updated contact, including its ID.',
        '',
        '**When to use:**',
        '- Adding someone to the list',
        '- Setting custom fields on a contact you may not have seen before',
        '',
        '**Key trigger phrases:** "add a contact", "add them to my list", "sign them up"',
      ].join('\n'),
      inputSchema: z.object({
        email: z.string().describe('Email address of the contact.'),
        subscribed: z.boolean().default(true).describe('Whether the contact is subscribed to marketing email.'),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Custom fields, e.g. {"plan":"pro","name":"Ada"}. Merged with any existing data.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({email, subscribed, data}) =>
      runTool(async () => {
        const contact = await client.request({
          method: 'POST',
          path: '/contacts',
          body: {email, subscribed, data},
        });

        return jsonResult('Contact created or updated:', contact);
      }),
  );

  register(
    ctx,
    'plunk_update_contact',
    {
      title: 'Update contact',
      description: [
        '**Purpose:** Change an existing contact by ID — its email address or custom data fields.',
        '',
        '**NOT for:** Creating a contact (use `plunk_create_contact`). Not for a plain opt-out or',
        'opt-in either — `plunk_unsubscribe_contact` and `plunk_subscribe_contact` do that in one step',
        'and accept an email address directly.',
        '',
        '**Returns:** The updated contact.',
        '',
        '**Important:** Setting a key in `data` to null deletes that key. Fields you omit are left',
        'untouched. Changing the email to one already used by another contact fails with 409.',
        '',
        '**Key trigger phrases:** "update their plan", "change their email", "set their custom field"',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().describe('The contact ID to update.'),
        email: z.string().optional().describe('New email address.'),
        subscribed: z.boolean().optional().describe('New subscription state.'),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Custom fields to merge. Set a key to null to delete that key.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, subscribed, data}) =>
      runTool(async () => {
        const contact = await client.request({
          method: 'PATCH',
          path: `/contacts/${encodeURIComponent(id)}`,
          body: {email, subscribed, data},
        });

        return jsonResult('Contact updated:', contact);
      }),
  );

  register(
    ctx,
    'plunk_delete_contact',
    {
      title: 'Delete contact',
      description: [
        '**Purpose:** Erase a contact, by email, external ID, or internal ID. This anonymizes the',
        "contact rather than destroying it: their email is nulled and their attributes are cleared,",
        'but the record and their send history are retained (so campaign stats stay accurate and any',
        'unsubscribe/manage links already delivered to them keep working). They become permanently',
        'unreachable and are dropped from every count and audience.',
        '',
        '**NOT for:** Stopping email to someone while keeping their record — use',
        '`plunk_unsubscribe_contact` instead. That is almost always what the user actually wants,',
        'and unlike deletion it is reversible.',
        '',
        '**Returns:** Confirmation of deletion.',
        '',
        '**This cannot be undone.** Confirm with the user before calling it. Deleting an already-',
        'deleted contact is a no-op, not an error.',
        '',
        '**Key trigger phrases:** "delete this contact", "remove them entirely", "GDPR erase"',
      ].join('\n'),
      inputSchema: z.object(contactRef),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, externalId}) =>
      runTool(async () => {
        const resolved = await resolveContact(client, {id, email, externalId});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        await client.request({method: 'DELETE', path: `/contacts/${encodeURIComponent(resolved.id)}`});
        return jsonResult('Contact deleted.', {id: resolved.id, deleted: true});
      }),
  );
}
