import * as z from 'zod';

import type {PlunkClient} from '../client.js';

import {contactRef, resolveContact} from './contacts.js';
import {errorResult, jsonResult, register, runTool, type ToolContext} from './shared.js';

interface Tag {
  id: string;
  name: string;
}

interface TagContactsPage {
  data: unknown[];
  page: number;
  pageSize: number;
  total: number;
}

/** Resolves a tag name to its ID by an exact (case-insensitive) match against the project's tags. */
async function resolveTag(client: PlunkClient, {id, name}: {id?: string; name?: string}): Promise<{id: string; label: string} | {error: string}> {
  if (id && name) {
    return {error: 'Pass either id or name, not both.'};
  }

  if (id) {
    return {id, label: id};
  }

  if (!name) {
    return {error: 'One of id or name is required.'};
  }

  const normalised = name.trim().toLowerCase();
  const tags = await client.request<Tag[]>({path: '/tags'});
  const match = tags.find((tag) => tag.name.toLowerCase() === normalised);

  if (!match) {
    return {error: `No tag named "${name}". Use plunk_list_tags to see what exists, or plunk_create_tag to make it.`};
  }

  return {id: match.id, label: match.name};
}

const tagRef = {
  id: z.string().optional().describe('The tag ID (a UUID). Use this when you already have it.'),
  name: z
    .string()
    .optional()
    .describe('The tag name. Resolved to the tag for you (exact, case-insensitive match) — prefer this if the user gave a name.'),
};

export function registerTagTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_tags',
    {
      title: 'List tags',
      description: [
        '**Purpose:** List every tag defined on the project.',
        '',
        '**NOT for:** Listing the contacts that carry a tag — use `plunk_list_tagged_contacts`.',
        '',
        '**Returns:** All tags with their IDs and names. Not paginated — projects have at most a few',
        'hundred tags.',
        '',
        '**When to use:** Before tagging a contact or building a tag-based campaign/segment, to find',
        'the tag ID, or to check whether a tag with a given name already exists.',
        '',
        '**Key trigger phrases:** "what tags do I have", "list my tags", "does a tag called X exist"',
      ].join('\n'),
      inputSchema: z.object({}),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async () =>
      runTool(async () => {
        const tags = await client.request<Tag[]>({path: '/tags'});
        return jsonResult(`Found ${tags.length} tag(s).`, tags);
      }),
  );

  register(
    ctx,
    'plunk_create_tag',
    {
      title: 'Create tag',
      description: [
        '**Purpose:** Create a new tag.',
        '',
        '**NOT for:** Applying a tag to a contact — creating it does not tag anyone. Use',
        '`plunk_tag_contact` after creating, or just pass the new name straight to `plunk_tag_contact`,',
        'which creates the tag if it does not already exist.',
        '',
        '**Returns:** The created tag, including its ID.',
        '',
        '**Note:** Tag names are unique per project (case-insensitive). Creating one that already',
        'exists fails — check `plunk_list_tags` first if unsure.',
        '',
        '**Key trigger phrases:** "create a tag", "add a new tag called"',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().max(100).describe('Tag name.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({name}) =>
      runTool(async () => {
        const tag = await client.request({method: 'POST', path: '/tags', body: {name}});
        return jsonResult('Tag created:', tag);
      }),
  );

  register(
    ctx,
    'plunk_rename_tag',
    {
      title: 'Rename tag',
      description: [
        '**Purpose:** Rename an existing tag, by ID or by its current name.',
        '',
        '**NOT for:** Creating a new tag (use `plunk_create_tag`) or applying/removing it on contacts.',
        '',
        '**Returns:** The updated tag.',
        '',
        '**Key trigger phrases:** "rename this tag", "call this tag something else"',
      ].join('\n'),
      inputSchema: z.object({
        ...tagRef,
        newName: z.string().max(100).describe('The new tag name.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, newName}) =>
      runTool(async () => {
        const resolved = await resolveTag(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const tag = await client.request({
          method: 'PATCH',
          path: `/tags/${encodeURIComponent(resolved.id)}`,
          body: {name: newName},
        });

        return jsonResult(`Tag "${resolved.label}" renamed to "${newName}":`, tag);
      }),
  );

  register(
    ctx,
    'plunk_delete_tag',
    {
      title: 'Delete tag',
      description: [
        '**Purpose:** Permanently delete a tag, by ID or by name. It is removed from every contact',
        'that carries it.',
        '',
        '**NOT for:** Untagging a single contact — use `plunk_untag_contact`, which leaves the tag',
        'itself intact for other contacts.',
        '',
        '**Returns:** Confirmation of deletion.',
        '',
        '**This cannot be undone**, and fails if the tag is still referenced by a campaign, workflow,',
        'or segment — remove those references first. Confirm with the user before calling it.',
        '',
        '**Key trigger phrases:** "delete this tag", "remove the tag entirely", "get rid of the tag"',
      ].join('\n'),
      inputSchema: z.object(tagRef),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name}) =>
      runTool(async () => {
        const resolved = await resolveTag(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        await client.request({method: 'DELETE', path: `/tags/${encodeURIComponent(resolved.id)}`});
        return jsonResult(`Tag "${resolved.label}" deleted.`, {id: resolved.id, deleted: true});
      }),
  );

  register(
    ctx,
    'plunk_list_tagged_contacts',
    {
      title: 'List contacts with a tag',
      description: [
        '**Purpose:** List the contacts that carry a given tag, by tag ID or name.',
        '',
        '**NOT for:** Listing all tags — use `plunk_list_tags`. Not for a full contact search — use',
        '`plunk_list_contacts`, which also accepts general filters.',
        '',
        '**Returns:** A page of contacts, plus `page`, `pageSize` and `total`.',
        '',
        '**Key trigger phrases:** "who has this tag", "show contacts tagged", "how many people have the tag"',
      ].join('\n'),
      inputSchema: z.object({
        ...tagRef,
        page: z.number().int().min(1).default(1).describe('Page number, starting at 1.'),
        pageSize: z.number().int().min(1).max(100).default(20).describe('Items per page (max 100).'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, page, pageSize}) =>
      runTool(async () => {
        const resolved = await resolveTag(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const result = await client.request<TagContactsPage>({
          path: `/tags/${encodeURIComponent(resolved.id)}/contacts`,
          query: {page, pageSize},
        });

        return jsonResult(`Tag "${resolved.label}": ${result.total} contact(s), showing page ${result.page}.`, result);
      }),
  );

  register(
    ctx,
    'plunk_tag_contact',
    {
      title: 'Tag contact',
      description: [
        '**Purpose:** Apply one or more tags to a single contact, identified by email or ID. Tags that',
        "don't already exist are created.",
        '',
        '**NOT for:** Tagging many contacts at once — there is no bulk tool exposed here; ask the user',
        'to use the dashboard for a bulk apply. Not for removing tags — use `plunk_untag_contact`.',
        '',
        '**Returns:** The tags now applied.',
        '',
        '**Key trigger phrases:** "tag this contact as", "add the VIP tag to", "label them"',
      ].join('\n'),
      inputSchema: z.object({
        ...contactRef,
        tagNames: z.array(z.string().max(100)).min(1).describe('Tag names to apply. Created if they do not exist.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, tagNames}) =>
      runTool(async () => {
        const resolvedContact = await resolveContact(client, {id, email});

        if ('error' in resolvedContact) {
          return errorResult(resolvedContact.error);
        }

        const existingTags = await client.request<Tag[]>({path: '/tags'});
        const tagIds = await Promise.all(
          tagNames.map(async (tagName) => {
            const normalised = tagName.trim().toLowerCase();
            const existing = existingTags.find((tag) => tag.name.toLowerCase() === normalised);
            if (existing) return existing.id;

            const created = await client.request<Tag>({method: 'POST', path: '/tags', body: {name: tagName}});
            return created.id;
          }),
        );

        const result = await client.request({
          method: 'POST',
          path: `/tags/contacts/${encodeURIComponent(resolvedContact.id)}`,
          body: {tagIds},
        });

        return jsonResult(`Tagged ${resolvedContact.label} with: ${tagNames.join(', ')}.`, result);
      }),
  );

  register(
    ctx,
    'plunk_untag_contact',
    {
      title: 'Untag contact',
      description: [
        '**Purpose:** Remove one or more tags from a single contact, identified by email or ID. The',
        'tags themselves are left intact for other contacts.',
        '',
        '**NOT for:** Deleting a tag entirely — use `plunk_delete_tag`.',
        '',
        '**Returns:** The contact’s remaining tags.',
        '',
        '**Key trigger phrases:** "remove the tag from", "untag them", "take off the VIP label"',
      ].join('\n'),
      inputSchema: z.object({
        ...contactRef,
        tagNames: z.array(z.string().max(100)).min(1).describe('Tag names to remove.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, email, tagNames}) =>
      runTool(async () => {
        const resolvedContact = await resolveContact(client, {id, email});

        if ('error' in resolvedContact) {
          return errorResult(resolvedContact.error);
        }

        const existingTags = await client.request<Tag[]>({path: '/tags'});
        const missing = tagNames.filter(
          (tagName) => !existingTags.some((tag) => tag.name.toLowerCase() === tagName.trim().toLowerCase()),
        );

        if (missing.length > 0) {
          return errorResult(`No tag(s) named: ${missing.join(', ')}. Use plunk_list_tags to see what exists.`);
        }

        const tagIds = tagNames.map((tagName) => {
          const normalised = tagName.trim().toLowerCase();
          return existingTags.find((tag) => tag.name.toLowerCase() === normalised)!.id;
        });

        const result = await client.request({
          method: 'DELETE',
          path: `/tags/contacts/${encodeURIComponent(resolvedContact.id)}`,
          body: {tagIds},
        });

        return jsonResult(`Removed from ${resolvedContact.label}: ${tagNames.join(', ')}.`, result);
      }),
  );
}
