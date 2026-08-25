import * as z from 'zod';

import type {PlunkClient} from '../client.js';

import {contactRef, resolveContact} from './contacts.js';
import {errorResult, jsonResult, register, runTool, type ToolContext} from './shared.js';

interface Sequence {
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED';
}

interface SequenceStep {
  id: string;
  order: number;
  subject: string;
  published: boolean;
}

interface SequenceWithSteps extends Sequence {
  steps: SequenceStep[];
}

/** Resolves a sequence name to its ID by an exact (case-insensitive) match against the project's sequences. */
async function resolveSequence(
  client: PlunkClient,
  {id, name}: {id?: string; name?: string},
): Promise<{id: string; label: string} | {error: string}> {
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
  const sequences = await client.request<Sequence[]>({path: '/sequences'});
  const match = sequences.find((sequence) => sequence.name.toLowerCase() === normalised);

  if (!match) {
    return {
      error: `No sequence named "${name}". Use plunk_list_sequences to see what exists, or plunk_create_sequence to make it.`,
    };
  }

  return {id: match.id, label: match.name};
}

const sequenceRef = {
  id: z.string().optional().describe('The sequence ID (a UUID). Use this when you already have it.'),
  name: z
    .string()
    .optional()
    .describe(
      'The sequence name. Resolved to the sequence for you (exact, case-insensitive match) — prefer this if the user gave a name.',
    ),
};

export function registerSequenceTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_sequences',
    {
      title: 'List sequences',
      description: [
        '**Purpose:** List every sequence on the project — an ordered series of emails that contacts',
        'move through one step at a time, each step delayed relative to their own previous send.',
        '',
        '**NOT for:** One-off sends to a whole audience — that is `plunk_list_campaigns` /',
        '`plunk_create_campaign`. Not for event-triggered branching automation, which is a workflow.',
        '',
        '**Returns:** All sequences with their status, step count and enrolled-contact count.',
        '',
        '**Key trigger phrases:** "what sequences do I have", "list my sequences", "my email series"',
      ].join('\n'),
      inputSchema: z.object({}),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async () =>
      runTool(async () => {
        const sequences = await client.request<Sequence[]>({path: '/sequences'});
        return jsonResult(`Found ${sequences.length} sequence(s).`, sequences);
      }),
  );

  register(
    ctx,
    'plunk_get_sequence',
    {
      title: 'Get sequence',
      description: [
        '**Purpose:** Read a single sequence and all of its steps in order, by ID or name.',
        '',
        '**Returns:** The sequence plus every step with its order, subject, delay and published flag.',
        'Unpublished steps are drafts — they are never sent until published.',
        '',
        '**Key trigger phrases:** "show me the sequence", "what emails are in", "read the steps"',
      ].join('\n'),
      inputSchema: z.object(sequenceRef),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const sequence = await client.request<SequenceWithSteps>({
          path: `/sequences/${encodeURIComponent(resolved.id)}`,
        });

        return jsonResult(`Sequence "${resolved.label}" with ${sequence.steps.length} step(s):`, sequence);
      }),
  );

  register(
    ctx,
    'plunk_get_sequence_stats',
    {
      title: 'Get sequence stats',
      description: [
        '**Purpose:** Aggregate engagement across every email the sequence has ever sent.',
        '',
        '**Returns:** Counts of sent, opened, clicked, bounced and complained.',
        '',
        '**Key trigger phrases:** "how is the sequence performing", "open rate for the sequence"',
      ].join('\n'),
      inputSchema: z.object(sequenceRef),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const stats = await client.request({path: `/sequences/${encodeURIComponent(resolved.id)}/stats`});
        return jsonResult(`Stats for sequence "${resolved.label}":`, stats);
      }),
  );

  register(
    ctx,
    'plunk_create_sequence',
    {
      title: 'Create sequence',
      description: [
        '**Purpose:** Create a sequence. It starts as a draft — nobody can be enrolled and nothing is',
        'sent until you set its status to ACTIVE with `plunk_update_sequence`.',
        '',
        '**NOT for:** Adding the emails themselves — use `plunk_add_sequence_step` afterwards.',
        '',
        '**Returns:** The created sequence, including its ID.',
        '',
        '**Note:** `from` must be on a domain verified for the project, otherwise activating the',
        'sequence is rejected. Check `plunk_list_domains` if unsure.',
        '',
        '**Key trigger phrases:** "create a sequence", "start an email series", "new drip"',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().max(100).describe('Sequence name.'),
        type: z
          .enum(['MARKETING', 'TRANSACTIONAL', 'HEADLESS'])
          .optional()
          .describe('Applies to every email in the sequence. Defaults to MARKETING.'),
        from: z.string().optional().describe('Sender address. Must be on a verified domain.'),
        fromName: z.string().optional().describe('Sender display name.'),
        replyTo: z.string().optional().describe('Reply-to address.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async (body) =>
      runTool(async () => {
        const sequence = await client.request({method: 'POST', path: '/sequences', body});
        return jsonResult('Sequence created:', sequence);
      }),
  );

  register(
    ctx,
    'plunk_update_sequence',
    {
      title: 'Update sequence',
      description: [
        '**Purpose:** Rename a sequence, change its sender, set its status, or bind a tag that',
        'auto-enrolls contacts.',
        '',
        '**Status meanings:** DRAFT rejects all enrollment. ACTIVE sends on schedule and honours the',
        'enrolling tag. PAUSED still accepts enrollment but sends nothing — progress is preserved and',
        'resumes on the next ACTIVE sweep.',
        '',
        '**Returns:** The updated sequence.',
        '',
        '**Key trigger phrases:** "activate the sequence", "pause the sequence", "rename it",',
        '"auto-enroll people tagged X"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        newName: z.string().max(100).optional().describe('New sequence name.'),
        status: z
          .enum(['DRAFT', 'ACTIVE', 'PAUSED'])
          .optional()
          .describe('DRAFT rejects enrollment, ACTIVE sends, PAUSED holds without losing progress.'),
        from: z.string().optional().describe('Sender address. Must be on a verified domain to go ACTIVE.'),
        fromName: z.string().optional().describe('Sender display name.'),
        replyTo: z.string().optional().describe('Reply-to address.'),
        enrollTagId: z
          .string()
          .nullable()
          .optional()
          .describe('Tag whose application auto-enrolls a contact while the sequence is ACTIVE. Pass null to unbind.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, newName, ...rest}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const sequence = await client.request({
          method: 'PATCH',
          path: `/sequences/${encodeURIComponent(resolved.id)}`,
          body: {...rest, ...(newName ? {name: newName} : {})},
        });

        return jsonResult(`Sequence "${resolved.label}" updated:`, sequence);
      }),
  );

  register(
    ctx,
    'plunk_delete_sequence',
    {
      title: 'Delete sequence',
      description: [
        '**Purpose:** Permanently delete a sequence, its steps, its enrollments and its send history.',
        '',
        '**NOT for:** Stopping sends temporarily — set the status to PAUSED instead, which keeps every',
        "contact's progress.",
        '',
        '**This cannot be undone.** Confirm with the user before calling it.',
        '',
        '**Key trigger phrases:** "delete the sequence", "get rid of the series"',
      ].join('\n'),
      inputSchema: z.object(sequenceRef),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        await client.request({method: 'DELETE', path: `/sequences/${encodeURIComponent(resolved.id)}`});
        return jsonResult(`Sequence "${resolved.label}" deleted.`, {id: resolved.id, deleted: true});
      }),
  );

  register(
    ctx,
    'plunk_add_sequence_step',
    {
      title: 'Add sequence step',
      description: [
        '**Purpose:** Append an email to the end of a sequence. It is created as a draft.',
        '',
        '**Delay:** `delayMinutes` counts from the contact\'s own previous send in this sequence, or',
        'from their enrollment for the first step. Use 0 to send as soon as they are eligible.',
        '',
        '**Returns:** The created step. It sends to nobody until `plunk_publish_sequence_step`.',
        '',
        '**Key trigger phrases:** "add an email to the sequence", "next in the series", "append a step"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        subject: z.string().max(255).describe('Email subject line.'),
        body: z.string().describe('Email body. Supports Liquid templating against contact data.'),
        delayMinutes: z
          .number()
          .int()
          .min(0)
          .describe("Minutes to wait after the contact's previous send in this sequence (or their enrollment)."),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({id, name, ...step}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const created = await client.request({
          method: 'POST',
          path: `/sequences/${encodeURIComponent(resolved.id)}/steps`,
          body: step,
        });

        return jsonResult(`Draft step added to "${resolved.label}". Publish it when it is ready:`, created);
      }),
  );

  register(
    ctx,
    'plunk_update_sequence_step',
    {
      title: 'Update sequence step',
      description: [
        '**Purpose:** Edit a step\'s subject, body or delay. Safe at any time — contacts who already',
        'received it are not re-sent, and contacts who have not reached it get the new version.',
        '',
        '**NOT for:** Publishing a draft — that is `plunk_publish_sequence_step`, and it is one-way.',
        '',
        '**Key trigger phrases:** "change the subject of step", "fix a typo in the sequence email"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        stepId: z.string().describe('The step ID. Get it from plunk_get_sequence.'),
        subject: z.string().max(255).optional().describe('New subject line.'),
        body: z.string().optional().describe('New body.'),
        delayMinutes: z.number().int().min(0).optional().describe('New delay in minutes.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, stepId, ...patch}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const step = await client.request({
          method: 'PATCH',
          path: `/sequences/${encodeURIComponent(resolved.id)}/steps/${encodeURIComponent(stepId)}`,
          body: patch,
        });

        return jsonResult(`Step updated in "${resolved.label}":`, step);
      }),
  );

  register(
    ctx,
    'plunk_publish_sequence_step',
    {
      title: 'Publish sequence step',
      description: [
        '**Purpose:** Publish a draft step so the sequence starts sending it.',
        '',
        '**This is one-way** — a published step cannot be unpublished, only deleted. Everyone already',
        'caught up on the sequence becomes eligible for it on the next sweep, so publishing reaches',
        'your whole enrolled audience. Confirm with the user before calling it.',
        '',
        '**Key trigger phrases:** "publish the step", "send out the new email in the series", "go live"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        stepId: z.string().describe('The step ID. Get it from plunk_get_sequence.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, stepId}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const step = await client.request({
          method: 'POST',
          path: `/sequences/${encodeURIComponent(resolved.id)}/steps/${encodeURIComponent(stepId)}/publish`,
        });

        return jsonResult(`Step published in "${resolved.label}":`, step);
      }),
  );

  register(
    ctx,
    'plunk_delete_sequence_step',
    {
      title: 'Delete sequence step',
      description: [
        '**Purpose:** Remove a step from a sequence. The remaining steps close up around it.',
        '',
        '**This cannot be undone**, and it discards the record of who received that step. Confirm with',
        'the user first.',
        '',
        '**Key trigger phrases:** "delete that step", "remove the email from the sequence"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        stepId: z.string().describe('The step ID. Get it from plunk_get_sequence.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, stepId}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        await client.request({
          method: 'DELETE',
          path: `/sequences/${encodeURIComponent(resolved.id)}/steps/${encodeURIComponent(stepId)}`,
        });

        return jsonResult(`Step deleted from "${resolved.label}".`, {id: stepId, deleted: true});
      }),
  );

  register(
    ctx,
    'plunk_reorder_sequence_steps',
    {
      title: 'Reorder sequence steps',
      description: [
        '**Purpose:** Set the order of a sequence\'s steps. Pass every step ID, in the order you want.',
        '',
        '**Safe by design:** progress is tracked per step, not by position, so reordering never',
        're-sends an email a contact already received and never skips one they have not.',
        '',
        '**Key trigger phrases:** "move that email earlier", "reorder the sequence", "swap steps"',
      ].join('\n'),
      inputSchema: z.object({
        ...sequenceRef,
        stepIds: z.array(z.string()).min(1).describe('Every step ID in the sequence, in the desired order.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, stepIds}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const sequence = await client.request({
          method: 'POST',
          path: `/sequences/${encodeURIComponent(resolved.id)}/steps/reorder`,
          body: {stepIds},
        });

        return jsonResult(`Steps reordered in "${resolved.label}":`, sequence);
      }),
  );

  register(
    ctx,
    'plunk_enroll_contact_in_sequence',
    {
      title: 'Enroll contact in sequence',
      description: [
        '**Purpose:** Add a single contact to a sequence, by email or ID. They start at the first',
        'published step.',
        '',
        '**NOT for:** Enrolling many contacts at once — there is no bulk tool exposed here; ask the',
        'user to use the dashboard, or bind an enrolling tag with `plunk_update_sequence` so tagging',
        'people enrolls them automatically.',
        '',
        '**Note:** enrolling into a DRAFT sequence is rejected. Enrolling someone twice is a no-op.',
        '',
        '**Key trigger phrases:** "add them to the sequence", "enroll this contact", "put them in the series"',
      ].join('\n'),
      inputSchema: z.object({...sequenceRef, ...contactRef}),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, ...contact}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const resolvedContact = await resolveContact(client, contact);

        if ('error' in resolvedContact) {
          return errorResult(resolvedContact.error);
        }

        const result = await client.request({
          method: 'POST',
          path: `/sequences/${encodeURIComponent(resolved.id)}/contacts`,
          body: {mode: 'ids', contactIds: [resolvedContact.id]},
        });

        return jsonResult(`${resolvedContact.label} enrolled in "${resolved.label}":`, result);
      }),
  );

  register(
    ctx,
    'plunk_unenroll_contact_from_sequence',
    {
      title: 'Unenroll contact from sequence',
      description: [
        '**Purpose:** Remove a contact from a sequence, by email or ID.',
        '',
        '**This also discards their send history for the sequence**, so re-enrolling them later starts',
        'the whole series over from the first step. To stop mail without losing that history,',
        'unsubscribe the contact instead — the sweep skips unsubscribed contacts but keeps their place.',
        '',
        '**Key trigger phrases:** "remove them from the sequence", "unenroll", "take them out of the series"',
      ].join('\n'),
      inputSchema: z.object({...sequenceRef, ...contactRef}),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true},
    },
    async ({id, name, ...contact}) =>
      runTool(async () => {
        const resolved = await resolveSequence(client, {id, name});

        if ('error' in resolved) {
          return errorResult(resolved.error);
        }

        const resolvedContact = await resolveContact(client, contact);

        if ('error' in resolvedContact) {
          return errorResult(resolvedContact.error);
        }

        await client.request({
          method: 'DELETE',
          path: `/sequences/${encodeURIComponent(resolved.id)}/contacts/${encodeURIComponent(resolvedContact.id)}`,
        });

        return jsonResult(`${resolvedContact.label} removed from "${resolved.label}".`, {
          sequenceId: resolved.id,
          contactId: resolvedContact.id,
          unenrolled: true,
        });
      }),
  );
}
