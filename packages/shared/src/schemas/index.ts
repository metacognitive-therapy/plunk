import {CampaignAudienceType, SequenceStatus, TemplateType, TrackingMode, WorkflowStepType, WorkflowTriggerType} from '@plunk/db';
import type {FilterCondition, FilterGroup} from '@plunk/types';
import {z} from 'zod';

const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.date()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | {[key: string]: Json} | Json[];
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([literalSchema, z.array(jsonSchema), z.record(jsonSchema)]));

const uuid = z.string().uuid();
const email = z.string().email();

export const UtilitySchemas = {
  id: z.object({
    id: uuid,
  }),
  email: z.object({
    email,
  }),
  pagination: z.object({
    page: z
      .union([z.number(), z.string()])
      .transform(value => parseInt(value as string, 10))
      .nullish()
      .transform(value => value ?? 1),
    limit: z
      .union([z.number(), z.string()])
      .transform(value => parseInt(value as string, 10))
      .nullish()
      .transform(value => value ?? 20),
    sort: z.enum(['alphabetical', 'latest']).default('latest'),
  }),
  query: z.object({
    query: z.string().min(3),
    filters: z
      .union([z.array(z.string()), z.string()])
      .transform(value => (Array.isArray(value) ? value : value.split('_').filter(Boolean)))
      .optional()
      .default([]),
  }),
} as const;

export const AuthenticationSchemas = {
  login: z.object({
    email,
    password: z.string().min(6),
  }),
  signup: z.object({
    email,
    password: z.string().min(6),
  }),
  verifyEmail: z.object({
    token: z.string().length(64, 'Invalid verification token'),
  }),
  requestPasswordReset: z.object({
    email,
  }),
  resetPassword: z.object({
    token: z.string().length(64, 'Invalid reset token'),
    newPassword: z.string().min(6, 'Password must be at least 6 characters'),
  }),
} as const;

// Zero-width / bidi / formatting characters that render invisibly and aren't normalized away by NFKC.
const invisibleCharRegex =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0]/u;

const projectName = z
  .string()
  .min(1)
  .max(100)
  .refine(val => !invisibleCharRegex.test(val), {
    message: 'Name contains invisible or formatting characters',
  })
  .refine(val => val.normalize('NFC') === val.normalize('NFKC'), {
    message: 'Name contains decorative or look-alike characters. Use plain letters and numbers.',
  });

export const ProjectSchemas = {
  create: z.object({
    name: projectName,
  }),
  update: z.object({
    name: projectName.optional(),
    tracking: z.nativeEnum(TrackingMode).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    // Sending pause: distinct from `disabled`. Stops sending only -- ingestion,
    // workflows, and sequence progression are unaffected. See
    // docs/issues/05-project-sending-pause.md.
    sendingPaused: z.boolean().optional(),
  }),
} as const;

export const ContactSchemas = {
  create: z.object({
    email,
    subscribed: z.boolean().default(true),
    data: jsonSchema.optional(),
  }),
  bulkAction: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('ids'),
      contactIds: z.array(uuid).min(1).max(1000),
    }),
    z.object({
      mode: z.literal('query'),
      filter: z
        .object({
          search: z.string().max(255).optional(),
          subscribed: z.boolean().optional(),
          tagIds: z.array(uuid).max(20).optional(),
        })
        .default({}),
      excludeIds: z.array(uuid).max(10000).optional(),
    }),
  ]),
  lookup: z.object({
    emails: z.array(z.string().email()).min(1).max(500),
  }),
} as const;

const segmentFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'greaterThan',
    'lessThan',
    'greaterThanOrEqual',
    'lessThanOrEqual',
    'exists',
    'notExists',
    'within',
    'olderThan',
    'triggered',
    'triggeredWithin',
    'triggeredOlderThan',
    'notTriggered',
    'notTriggeredWithin',
    'memberOfSegment',
    'notMemberOfSegment',
    'hasTag',
    'notHasTag',
  ]),
  value: z.any().optional(),
  unit: z.enum(['days', 'hours', 'minutes']).optional(),
});

const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    filters: z.array(segmentFilterSchema),
    conditions: filterConditionSchema.optional(),
  }),
);

const filterConditionSchema: z.ZodType<FilterCondition> = z.lazy(() =>
  z.object({
    logic: z.enum(['AND', 'OR']),
    groups: z.array(filterGroupSchema).min(1),
  }),
);

export const SegmentSchemas = {
  filter: segmentFilterSchema,
  filterGroup: filterGroupSchema,
  filterCondition: filterConditionSchema,
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    type: z.enum(['DYNAMIC', 'STATIC']).default('DYNAMIC'),
    condition: filterConditionSchema.optional(),
    trackMembership: z.boolean().default(false),
  }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    type: z.enum(['DYNAMIC', 'STATIC']).optional(),
    condition: filterConditionSchema.optional(),
    trackMembership: z.boolean().optional(),
  }),
  members: z.object({
    emails: z.array(z.string().email()).min(1).max(500),
    createMissing: z.boolean().optional(),
    subscribed: z.boolean().optional(),
  }),
};

export const TagSchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(100),
  }),
  update: z.object({
    name: z.string().trim().min(1).max(100),
  }),
  // Bulk add/remove across many contacts, mirroring ContactSchemas.bulkAction's
  // two selection modes (explicit ids, or a query + exclusion list for "select
  // all matching").
  bulkApply: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('ids'),
      contactIds: z.array(uuid).min(1).max(1000),
      tagIds: z.array(uuid).min(1).max(20),
      action: z.enum(['add', 'remove']),
    }),
    z.object({
      mode: z.literal('query'),
      filter: z
        .object({
          search: z.string().max(255).optional(),
          subscribed: z.boolean().optional(),
          tagIds: z.array(uuid).max(20).optional(),
        })
        .default({}),
      excludeIds: z.array(uuid).max(10000).optional(),
      tagIds: z.array(uuid).min(1).max(20),
      action: z.enum(['add', 'remove']),
    }),
  ]),
};

/** Ten years, in minutes — see the note on `createStep.delayMinutes`. */
export const MAX_DELAY_MINUTES = 3650 * 24 * 60;

export const SequenceSchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(100),
    type: z.nativeEnum(TemplateType).default('MARKETING'),
    from: email.nullish(),
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    enrollTagId: uuid.nullish(),
  }),
  update: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    status: z.nativeEnum(SequenceStatus).optional(),
    type: z.nativeEnum(TemplateType).optional(),
    from: email.nullish(),
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    enrollTagId: uuid.nullish(),
  }),
  createStep: z.object({
    subject: z.string().min(1),
    body: z.string().min(1),
    // Capped at ten years. The dashboard lets the delay be entered in days, which
    // multiplies by 1440, so an unbounded value could overflow the int4 column.
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES),
  }),
  // Publishing is explicit and one-way (POST .../publish); updates cannot flip it
  updateStep: z.object({
    subject: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    delayMinutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).optional(),
  }),
  // The full ordering: every step id of the sequence, exactly once, in the new order
  reorderSteps: z.object({
    stepIds: z.array(uuid).min(1).max(500),
  }),
  // Bulk enrollment, mirroring TagSchemas.bulkApply's two selection modes
  enroll: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('ids'),
      contactIds: z.array(uuid).min(1).max(1000),
    }),
    z.object({
      mode: z.literal('query'),
      filter: z
        .object({
          search: z.string().max(255).optional(),
          subscribed: z.boolean().optional(),
          tagIds: z.array(uuid).max(20).optional(),
        })
        .default({}),
      excludeIds: z.array(uuid).max(10000).optional(),
    }),
  ]),
};

export const TemplateSchemas = {
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    from: email,
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).default('MARKETING'),
  }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    subject: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    from: email.optional(),
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).optional(),
  }),
  // Bulk operation payload for POST /templates/bulk-update.
  //
  // Currently the only supported operation is `delete: true` (bulk delete).
  // The schema is intentionally kept open-ended so future tag-related fields
  // (e.g. `addTags?: string[]`, `removeTags?: string[]`) can stack onto the
  // same endpoint once a `Template.tags` column exists — without changing the
  // request shape callers already depend on. Keep this as the single source of
  // truth for what bulk operations the endpoint accepts.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
  }),
};

export const WorkflowSchemas = {
  create: z
    .object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      eventName: z.string().min(1).optional(),
      // Alternative to eventName: trigger when a specific tag is added/removed.
      // Bound by tagId (not name), so renaming the tag never breaks this workflow.
      // Internally this still creates an EVENT-type trigger on the reserved
      // tag.added / tag.removed event name, with tagId carried in triggerConfig.
      tagTrigger: z
        .object({
          tagId: uuid,
          direction: z.enum(['added', 'removed']),
        })
        .optional(),
      allowReentry: z.boolean().optional(),
      enabled: z.boolean().default(false),
    })
    .refine(data => !!data.eventName || !!data.tagTrigger, {
      message: 'Provide either eventName or tagTrigger',
    }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    triggerType: z.nativeEnum(WorkflowTriggerType).optional(),
    triggerConfig: jsonSchema.optional(),
    enabled: z.boolean().optional(),
    allowReentry: z.boolean().optional(),
  }),
  addStep: z.object({
    type: z.nativeEnum(WorkflowStepType),
    name: z.string().min(1).max(100),
    position: jsonSchema,
    config: jsonSchema,
    templateId: uuid.optional(),
    autoConnect: z.boolean().optional(),
  }),
  updateStep: z.object({
    name: z.string().min(1).max(100).optional(),
    position: jsonSchema.optional(),
    config: jsonSchema.optional(),
    templateId: uuid.optional().nullable(),
  }),
  // Payload for POST /workflows/:id/transitions/:transitionId/insert-step.
  // Mirrors `addStep` minus `autoConnect` (the transition being split already
  // determines both sides of the wiring) and with an optional position, since
  // the builder lays the graph out with dagre anyway.
  insertStep: z.object({
    type: z.nativeEnum(WorkflowStepType),
    name: z.string().min(1).max(100),
    position: jsonSchema.optional(),
    config: jsonSchema,
    templateId: uuid.optional(),
  }),
  createTransition: z.object({
    fromStepId: uuid,
    toStepId: uuid,
    condition: jsonSchema.optional(),
    priority: z.number().int().min(0).default(0),
  }),
  startExecution: z.object({
    contactId: uuid,
    context: jsonSchema.optional(),
  }),
  // Bulk operation payload for POST /workflows/bulk-update.
  //
  // Currently the only supported operation is `delete: true` (bulk delete).
  // Mirrors `TemplateSchemas.bulkUpdate` and is intentionally kept open-ended so
  // future bulk operations (e.g. enable/disable) can stack onto the same
  // endpoint without changing the request shape callers already depend on.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
  }),
};

export const WorkflowStepConfigSchemas = {
  sendEmail: z.object({
    templateId: uuid,
    recipient: z
      .object({
        type: z.enum(['CONTACT', 'CUSTOM']),
        customEmail: email.optional(),
      })
      .refine(
        data => {
          // If type is CUSTOM, customEmail must be provided
          if (data.type === 'CUSTOM') {
            return !!data.customEmail;
          }
          return true;
        },
        {
          message: 'Custom email is required when recipient type is CUSTOM',
        },
      )
      .optional(),
  }),
  delay: z
    .object({
      amount: z.number().positive(),
      unit: z.enum(['minutes', 'hours', 'days']),
    })
    .refine(
      data => {
        // Max 365 days
        const maxMinutes = 365 * 24 * 60;
        const maxHours = 365 * 24;
        const maxDays = 365;

        if (data.unit === 'minutes') return data.amount <= maxMinutes;
        if (data.unit === 'hours') return data.amount <= maxHours;
        if (data.unit === 'days') return data.amount <= maxDays;
        return true;
      },
      {
        message: 'Delay cannot exceed 365 days',
      },
    ),
  waitForEvent: z.object({
    eventName: z.string().min(1),
    timeout: z.number().positive().max(31536000, 'Timeout cannot exceed 365 days (31,536,000 seconds)').optional(),
  }),
  condition: z.union([
    // Legacy binary condition (if/else)
    z.object({
      field: z.string().min(1),
      operator: z.enum([
        'equals',
        'notEquals',
        'contains',
        'notContains',
        'greaterThan',
        'lessThan',
        'greaterThanOrEqual',
        'lessThanOrEqual',
        'exists',
        'notExists',
        'hasTag',
        'notHasTag',
      ]),
      value: z.any().optional(),
    }),
    // Multi-branch condition (switch/case)
    z.object({
      mode: z.literal('multi'),
      field: z.string().min(1),
      branches: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            operator: z.enum([
              'equals',
              'notEquals',
              'contains',
              'notContains',
              'greaterThan',
              'lessThan',
              'greaterThanOrEqual',
              'lessThanOrEqual',
              'exists',
              'notExists',
              'hasTag',
              'notHasTag',
            ]),
            value: z.any().optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  ]),
  webhook: z.object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z.record(z.string()).optional(),
    body: jsonSchema.optional(),
  }),
  updateContact: z
    .object({
      updates: z.record(z.any()).optional(),
      subscriptionAction: z.enum(['none', 'subscribe', 'unsubscribe']).optional(),
    })
    .refine(
      value =>
        (value.updates && Object.keys(value.updates).length > 0) ||
        (value.subscriptionAction && value.subscriptionAction !== 'none'),
      {message: 'Provide at least one field to update or a subscription action'},
    ),
  // Shared by ADD_TAG and REMOVE_TAG steps.
  tagAction: z.object({
    tagId: uuid,
  }),
};

export const DomainSchemas = {
  create: z.object({
    projectId: uuid,
    domain: z
      .string()
      .min(3)
      .max(253)
      .refine(
        value => {
          // Basic domain validation regex
          const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
          return domainRegex.test(value);
        },
        {
          message: 'Invalid domain format',
        },
      ),
  }),
  projectId: z.object({
    projectId: uuid,
  }),
};

export const CampaignSchemas = {
  create: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    from: email,
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).default(TemplateType.MARKETING),
    audienceType: z.nativeEnum(CampaignAudienceType),
    audienceCondition: filterConditionSchema.optional(),
    segmentId: uuid.optional(),
    tagIds: z.array(uuid).max(50).optional(),
    excludeTagIds: z.array(uuid).max(50).optional(),
  }),
  schedule: z.object({
    scheduledFor: z.string(),
  }),
  update: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    from: z.string().optional(),
    fromName: z.string().max(100).nullish(),
    replyTo: z.string().nullish(),
    type: z.nativeEnum(TemplateType).optional(),
    audienceType: z.nativeEnum(CampaignAudienceType).optional(),
    audienceCondition: filterConditionSchema.optional(),
    segmentId: z.string().optional(),
    tagIds: z.array(uuid).max(50).optional(),
    excludeTagIds: z.array(uuid).max(50).optional(),
  }),
  sendTest: z.object({
    email,
  }),
  // Bulk operation payload for POST /campaigns/bulk-update.
  //
  // Currently the only supported operation is `delete: true` (bulk delete).
  // Mirrors `TemplateSchemas.bulkUpdate` and is intentionally kept open-ended so
  // future bulk operations can stack onto the same endpoint without changing the
  // request shape callers already depend on.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
  }),
} as const;

// Callers report occurrence time as an ISO string or epoch millis; z.coerce.date() also
// rejects anything that isn't a parseable date (e.g. "not-a-date") with a normal ZodError,
// which is what "validate it" in the issue asks for.
//
// Bound: reject anything more than 5 minutes in the future. A real occurrence can never be
// in the future, but clocks drift a little between caller and server, so a small allowance
// avoids rejecting legitimate near-real-time tracking calls. Anything further out is far
// more likely a caller bug (e.g. a unix-seconds timestamp misread as milliseconds, landing
// decades in the future) than a genuine event, and letting it through would silently corrupt
// segment recency windows - the exact failure mode this field exists to prevent.
const MAX_OCCURRED_AT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const occurredAt = z.preprocess(
  // A client that omits the field by serializing it as `null` (common for optional fields in
  // some JSON serializers) would otherwise reach z.coerce.date() as `null`, which JS Date
  // happily coerces to the epoch (1970-01-01) instead of failing validation - silently
  // pinning the event permanently outside every "triggered within" window. Normalize null to
  // undefined first so it's treated the same as a genuinely omitted field.
  value => (value === null ? undefined : value),
  z.coerce
    .date()
    .refine(date => date.getTime() <= Date.now() + MAX_OCCURRED_AT_CLOCK_SKEW_MS, {
      message: 'occurredAt cannot be in the future',
    })
    .optional(),
);

export const ActionSchemas = {
  track: z.object({
    event: z.string().min(1),
    email,
    subscribed: z.boolean().optional(),
    data: jsonSchema.optional(),
    // Tag names to apply to the contact (auto-created if missing, matched case-insensitively).
    tags: z.array(z.string().min(1).max(100)).max(20).optional(),
    // When the event actually happened, as opposed to when Plunk received it. Defaults to
    // now when omitted. Only segment/campaign-audience recency filters read this value -
    // the event feeds and stats keep reading ingestion time.
    occurredAt,
  }),
  send: z
    .object({
      to: z.union([
        email, // Simple email string (backward compatible)
        z.object({
          // Object with name and email
          name: z.string().optional(),
          email: email,
        }),
        z.array(
          z.union([
            email, // Array of email strings
            z.object({
              // Array of objects with name and email
              name: z.string().optional(),
              email: email,
            }),
          ]),
        ),
      ]),
      subject: z.string().min(1).max(998).regex(/^[^\r\n]*$/, 'Subject contains invalid characters').optional(),
      body: z.string().min(1).optional(),
      template: uuid.optional(),
      subscribed: z.boolean().optional(),
      name: z.string().optional(),
      from: z
        .union(
          [
            email, // Simple email string (backward compatible)
            z.object({
              // Object with name and email
              name: z.string().regex(/^[^\r\n]*$/, 'Name contains invalid characters').optional(),
              email: email,
            }),
          ],
          {
            errorMap: (issue, ctx) => {
              if (issue.code === z.ZodIssueCode.invalid_union) {
                return {
                  message:
                    'Invalid "from" field. Expected a valid email string (e.g., "hello@example.com") or an object with an email field and optional name (e.g., {email: "hello@example.com", name: "My App"})',
                };
              }
              return {message: ctx.defaultError};
            },
          },
        )
        .optional(),
      reply: email.optional(),
      headers: z
        .record(
          z.string().regex(/^[^\r\n]+$/, 'Header key contains invalid characters'),
          z.string().max(998).regex(/^[^\r\n]*$/, 'Header value contains invalid characters'),
        )
        .optional(),
      data: jsonSchema.optional(),
      attachments: z
        .array(
          z.object({
            filename: z.string().min(1).max(255).regex(/^[^\r\n"]+$/, 'Filename contains invalid characters'),
            content: z.string().min(1), // Base64 encoded file content
            contentType: z.string().min(1).max(255),
            contentId: z
              .string()
              .min(1)
              .max(255)
              .regex(/^[^<>\r\n]+$/, 'Content ID cannot contain <, >, \\r, or \\n')
              .optional(),
            disposition: z.enum(['attachment', 'inline']).default('attachment'),
          })
            .refine(data => data.disposition !== 'inline' || !!data.contentId, {
              message: 'Content ID is required when disposition is inline',
              path: ['contentId'],
            }),
        )
        .max(Number(process.env['MAX_ATTACHMENTS_COUNT'] ?? 10))
        .optional(),
    })
    .superRefine((data, ctx) => {
      // Validate that either template or subject+body are provided
      if (!data.template && !(data.subject && data.body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either template ID or both subject and body are required',
          path: ['template'],
        });
      }

      // Validate total attachment size
      if (data.attachments && data.attachments.length > 0) {
        const maxSizeMb = Number(process.env['MAX_ATTACHMENT_SIZE_MB'] ?? 10);
        const maxBase64Length = Math.floor((maxSizeMb * 1024 * 1024 * 4) / 3);
        const totalBase64Length = data.attachments.reduce((sum, att) => sum + att.content.length, 0);
        if (totalBase64Length > maxBase64Length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Total attachment size must not exceed ${maxSizeMb}MB`,
            path: ['attachments'],
          });
        }
      }
    }),
  verify: z.object({
    email,
  }),
  // Minimal form only (docs/issues/01-leads-contacts-without-email.md): an external id with no
  // email, creating a lead. Resolving an external id against an existing email-bearing contact
  // is slice 02's job -- this schema deliberately has no `email` field yet.
  identify: z.object({
    externalId: z.string().min(1).max(255),
    subscribed: z.boolean().optional(),
    data: jsonSchema.optional(),
  }),
} as const;

export const BillingLimitSchemas = {
  update: z.object({
    workflows: z.coerce.number().int().positive().nullable(),
    campaigns: z.coerce.number().int().positive().nullable(),
    transactional: z.coerce.number().int().positive().nullable(),
    inbound: z.coerce.number().int().positive().nullable(),
  }),
} as const;

export const MembershipSchemas = {
  addMember: z.object({
    email,
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
  }),
  updateRole: z.object({
    role: z.enum(['ADMIN', 'MEMBER']),
  }),
} as const;
