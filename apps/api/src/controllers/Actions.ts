import {Controller, Middleware, Post} from '@overnightjs/core';
import {ActionSchemas} from '@plunk/shared';
import type {Contact} from '@plunk/db';
import type {NextFunction, Request, Response} from 'express';
import {requirePublicKey, requireSecretKey} from '../middleware/auth.js';
import {idempotency} from '../middleware/idempotency.js';
import {sendRateLimit, trackRateLimit} from '../middleware/rateLimit.js';
import {prisma} from '../database/prisma.js';
import {ContactService} from '../services/ContactService.js';
import {DomainService} from '../services/DomainService.js';
import {EmailService} from '../services/EmailService.js';
import {EmailVerificationService} from '../services/EmailVerificationService.js';
import {EventService} from '../services/EventService.js';
import {TagService} from '../services/TagService.js';
import {NotFound, ValidationError} from '../exceptions/index.js';
import {CatchAsync} from '../utils/asyncHandler.js';
import {DASHBOARD_URI} from '../app/constants.js';

/**
 * Public API Actions Controller
 * Handles track event, transactional email, and email verification endpoints
 */
@Controller('v1')
export class Actions {
  /**
   * POST /v1/track
   * Track an event for a contact (creates/updates contact and tracks event)
   *
   * Headers:
   * - Idempotency-Key: string (optional) - Refuses the request with 409 if this key
   *   was already used by this project. See middleware/idempotency.ts.
   *
   * Request body:
   * - event: string (required) - Event name
   * - email: string (required unless externalId is given) - Contact email. Resolves-or-creates
   *   the contact, exactly as before.
   * - externalId: string (required unless email is given) - Caller-supplied stable id for a
   *   contact that must ALREADY exist (see docs/issues/03-track-by-external-id.md). Mutually
   *   exclusive with `email`. This path only ever RESOLVES a contact, never creates one -- the
   *   public key that authorises this endpoint carries no origin restriction, so "never create"
   *   is what stops a leaked key from conjuring contacts for arbitrary addresses and mailing
   *   them. An unknown externalId returns a 404 (distinguishable from a malformed request)
   *   rather than silently dropping the event. `subscribed` is rejected on this path -- consent
   *   changes go through /v1/identify only, so recording behaviour can never re-subscribe
   *   someone who opted out.
   * - subscribed: boolean (optional, email path only) - Contact subscription status (only
   *   updates if explicitly specified)
   * - data: object (optional) - Event data. On the email path, simple values are ALSO saved to
   *   the contact (persistent), matching existing behaviour. On the externalId path, `data` is
   *   recorded on the event and available to workflows but is NEVER merged onto the contact --
   *   identify is the only writer of persistent contact attributes.
   *   - {value: any, persistent: false} are only available to workflows (non-persistent)
   * - occurredAt: string | number (optional) - When the event actually happened (ISO date
   *   string or epoch), as opposed to when Plunk received it. Defaults to now if omitted.
   *   Segment/campaign-audience recency filters ("triggered since" / "triggered older than")
   *   evaluate against this value, not against ingestion time - so a retried or queued
   *   request still lands in the correct audience window.
   *
   * Response:
   * - success: boolean
   * - data: object with contact ID, event ID, and timestamp
   *
   * Example:
   * {
   *   event: "purchase",
   *   email: "user@example.com",
   *   data: {
   *     totalSpent: 1500,                          // Persistent - saved to contact
   *     plan: "pro",                                // Persistent - saved to contact
   *     orderId: {value: "12345", persistent: false},  // Non-persistent - workflows only
   *     receiptUrl: {value: "https://...", persistent: false}  // Non-persistent - workflows only
   *   }
   * }
   *
   * Example (externalId, resolve-only):
   * {
   *   event: "purchase",
   *   externalId: "user_8f3a2c",
   *   data: {orderId: {value: "12345", persistent: false}}
   * }
   */
  @Post('track')
  @Middleware([requirePublicKey, trackRateLimit, idempotency])
  @CatchAsync
  public async track(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    // Zod validation - errors automatically handled by global error handler
    // (the schema itself enforces email/externalId mutual exclusivity, requires one of the
    // two, and rejects `subscribed` alongside externalId -- see ActionSchemas.track)
    const {event, email, externalId, subscribed, data, tags, occurredAt} = ActionSchemas.track.parse(req.body);

    // Prevent manual tracking of reserved system events
    if (EventService.isReservedEvent(event)) {
      throw new ValidationError(
        [
          {
            field: 'event',
            message: `Event name "${event}" is reserved for system use and cannot be manually tracked`,
            code: 'reserved_event',
            received: event,
          },
        ],
        'Cannot track reserved system event',
      );
    }

    let contact: Contact;
    if (externalId) {
      // externalId path: RESOLVE ONLY, never create (docs/issues/03-track-by-external-id.md).
      // `data` is intentionally NOT passed to a merge step here -- it flows only to
      // EventService.trackEvent below, so it's recorded on the event and available to
      // workflows without ever touching the contact's persistent attributes.
      const resolved = await ContactService.findByExternalId(auth.projectId, externalId);
      if (!resolved) {
        // Distinguishable not-found: an integration can tell "this user isn't in Plunk yet"
        // apart from a malformed request, instead of the event silently vanishing.
        throw new NotFound('Contact', externalId);
      }
      contact = resolved;
    } else {
      // Existing email path, byte-for-byte unchanged: create or update contact with
      // persistent data only. ContactService.upsert will filter out non-persistent fields.
      // Event tracking should subscribe new contacts by default (subscribed=true in
      // ContactService) but preserve existing subscription state for existing contacts.
      contact = await ContactService.upsert(
        auth.projectId,
        email!,
        data as Record<string, unknown> | undefined,
        subscribed,
      );
    }

    // Track the event with ALL data (persistent + non-persistent)
    // Non-persistent data flows to workflows via execution context
    const eventRecord = await EventService.trackEvent(
      auth.projectId,
      event,
      contact.id,
      undefined,
      data as Record<string, unknown> | undefined,
      occurredAt,
    );

    // Apply any tags supplied on the same call - resolved/auto-created by name,
    // then applied after the event so tag.added workflow triggers see a contact
    // that already has this event's data.
    if (tags && tags.length > 0) {
      const resolvedTags = await TagService.resolveOrCreateByNames(auth.projectId, tags);
      await TagService.applyTags(
        auth.projectId,
        contact.id,
        resolvedTags.map(tag => tag.id),
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        contact: contact.id,
        event: eventRecord.id,
        timestamp: eventRecord.createdAt.toISOString(),
      },
    });
  }

  /**
   * POST /v1/send
   * Send transactional email(s)
   *
   * Headers:
   * - Idempotency-Key: string (optional) - Refuses the request with 409 if this key
   *   was already used by this project. See middleware/idempotency.ts.
   *
   * Request body:
   * - to: string | object | array (required) - Recipient email(s)
   *   - String: "user@example.com"
   *   - Object: {name: "Jane Doe", email: "user@example.com"}
   *   - Array: ["user1@example.com", {name: "Jane", email: "user2@example.com"}]
   * - subject: string (required) - Email subject
   * - body: string (required) - Email HTML body
   * - subscribed: boolean (optional) - Contact subscription status (only updates if explicitly specified)
   * - name: string (optional) - Sender name (alternative to from.name)
   * - from: string | object (optional) - Sender email or {name, email} object (must be from verified domain)
   * - reply: string (optional) - Reply-to email
   * - headers: object (optional) - Additional email headers
   * - data: object (optional) - Contact data and template variables
   *   - Simple values are saved to contact (persistent)
   *   - {value: any, persistent: false} are only used for this email (non-persistent)
   * - attachments: array (optional) - Email attachments (configurable via MAX_ATTACHMENTS_COUNT / MAX_ATTACHMENT_SIZE_MB, defaults: 10 / 10MB)
   *   - filename: string (required) - Attachment filename
   *   - content: string (required) - Base64 encoded file content
   *   - contentType: string (required) - MIME type (e.g., "application/pdf")
   *
   * Response:
   * - success: boolean
   * - data: object with emails array and timestamp
   *
   * Examples:
   *
   * Simple format (backward compatible):
   * {
   *   to: "user@example.com",
   *   subject: "Password Reset",
   *   body: "<p>Reset code: {{resetCode}}</p><p>Hello {{firstName}}!</p>",
   *   from: "noreply@example.com",
   *   name: "My App",
   *   data: {
   *     firstName: "John",                              // Persistent - saved to contact
   *     resetCode: {value: "ABC123", persistent: false} // Non-persistent - this email only
   *   }
   * }
   *
   * Object format (recommended):
   * {
   *   to: {
   *     name: "Jane Doe",
   *     email: "user@example.com"
   *   },
   *   subject: "Password Reset",
   *   body: "<p>Reset code: {{resetCode}}</p>",
   *   from: {
   *     name: "My App",
   *     email: "noreply@example.com"
   *   }
   * }
   *
   * Multiple recipients with names:
   * {
   *   to: [
   *     {name: "Jane Doe", email: "jane@example.com"},
   *     {name: "John Smith", email: "john@example.com"}
   *   ],
   *   subject: "Newsletter",
   *   body: "<p>Hello {{name}}!</p>",
   *   from: {name: "Newsletter", email: "news@example.com"}
   * }
   */
  @Post('send')
  @Middleware([requireSecretKey, sendRateLimit, idempotency])
  @CatchAsync
  public async send(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    // Zod validation - errors automatically handled by global error handler
    const {to, subject, body, subscribed, name, from, reply, headers, data, template, attachments} =
      ActionSchemas.send.parse(req.body);

    // Inline subject/body are templates too, but they are deliberately NOT syntax
    // checked here. Transactional bodies are generated by whatever system calls us —
    // Handlebars output, front-end framework markup, an unbalanced `{{` in a code
    // sample — and those sent fine before Liquid existed. Rejecting them now would
    // break live integrations over markup the renderer already handles by falling back
    // to plain placeholder substitution. Authoring-time surfaces (templates, campaigns)
    // are where a syntax error is worth failing the write.

    // Normalize recipients to array and parse email/name
    type Recipient = {email: string; name?: string};
    const recipients: Recipient[] = (Array.isArray(to) ? to : [to]).map(recipient => {
      if (typeof recipient === 'string') {
        return {email: recipient};
      } else {
        return {email: recipient.email, name: recipient.name};
      }
    });

    // Parse 'from' field - can be string or object {name, email}
    let emailFrom: string | undefined;
    let emailFromName: string | undefined;

    if (typeof from === 'string') {
      // Backward compatible: from is just an email string
      emailFrom = from;
      emailFromName = name; // Use separate 'name' field if provided
    } else if (from && typeof from === 'object') {
      // New format: from is an object with {name, email}
      emailFrom = from.email;
      emailFromName = from.name || name; // Prefer from.name, fallback to separate 'name' field
    } else {
      // No 'from' provided
      emailFromName = name;
    }

    // Fetch template if provided
    let emailSubject = subject;
    let emailBody = body;
    let emailReplyTo = reply;
    let templateId: string | undefined;

    if (template) {
      const templateRecord = await prisma.template.findUnique({
        where: {
          id: template,
          projectId: auth.projectId, // Ensure template belongs to this project
        },
      });

      if (!templateRecord) {
        throw new NotFound('Template', template);
      }

      // Use template values, allow overrides from request
      emailSubject = subject || templateRecord.subject;
      emailBody = body || templateRecord.body;

      // Handle from field - if not already set and template has a from, use it
      if (!emailFrom && templateRecord.from) {
        emailFrom = templateRecord.from;
      }
      if (!emailFromName && templateRecord.fromName) {
        emailFromName = templateRecord.fromName;
      }

      emailReplyTo = reply || templateRecord.replyTo || undefined;
      templateId = templateRecord.id;
    }

    if (!emailFrom) {
      throw new ValidationError(
        [
          {
            field: 'from',
            message: 'Sender email is required either in request or template',
            code: 'required',
          },
        ],
        'Could not parse sender email',
      );
    }

    await DomainService.verifyEmailDomain(emailFrom, auth.projectId);

    const replyToEmail = emailReplyTo;

    const timestamp = new Date();
    const emailResults = [];

    // Process each recipient
    for (const recipient of recipients) {
      // Merge recipient name with data if provided
      const recipientData = recipient.name
        ? {...(data as Record<string, unknown> | undefined), name: recipient.name}
        : (data as Record<string, unknown> | undefined);

      // Create or update contact with metadata
      // Transactional emails should not subscribe contacts by default
      // New contacts default to unsubscribed unless explicitly opted in
      // Existing contacts preserve their subscription state unless explicitly changed
      const contact = await ContactService.upsert(auth.projectId, recipient.email, recipientData, subscribed, false);

      // Get merged data including non-persistent fields for template rendering
      const mergedData = ContactService.getMergedData(contact, data as Record<string, unknown> | undefined);

      // Add system variables (email, unsubscribe URLs, etc.) to merged data
      // These are always available for template rendering
      const dataWithSystemVars = {
        ...mergedData,
        id: contact.id,
        email: contact.email,
        data: mergedData, // Also available as nested data for {{data.fieldName}} syntax
        unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/${contact.id}`,
        subscribeUrl: `${DASHBOARD_URI}/subscribe/${contact.id}`,
        manageUrl: `${DASHBOARD_URI}/manage/${contact.id}`,
      };

      // Render template with contact data
      // Simple template variable replacement: {{fieldname}}
      let renderedSubject = emailSubject!;
      let renderedBody = emailBody!;

      for (const [key, value] of Object.entries(dataWithSystemVars)) {
        const placeholder = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        const fallbackPlaceholder = new RegExp(`\\{\\{\\s*${key}\\s*\\?\\?\\s*([^}]+)\\}\\}`, 'g');

        // Replace with value
        const stringValue = value !== null && value !== undefined ? String(value) : '';
        renderedSubject = renderedSubject!.replace(placeholder, stringValue);
        renderedBody = renderedBody!.replace(placeholder, stringValue);

        // Handle fallback syntax: {{field ?? default}}
        renderedSubject = renderedSubject!.replace(fallbackPlaceholder, stringValue || '$1');
        renderedBody = renderedBody!.replace(fallbackPlaceholder, stringValue || '$1');
      }

      // Replace any remaining placeholders with empty string or fallback value
      renderedSubject = renderedSubject!.replace(/\{\{\s*(\w+)\s*\}\}/g, '');
      renderedBody = renderedBody!.replace(/\{\{\s*(\w+)\s*\}\}/g, '');

      // Handle fallback placeholders that weren't matched
      renderedSubject = renderedSubject!.replace(/\{\{\s*\w+\s*\?\?\s*([^}]+)\}\}/g, '$1');
      renderedBody = renderedBody!.replace(/\{\{\s*\w+\s*\?\?\s*([^}]+)\}\}/g, '$1');

      const email = await EmailService.sendTransactionalEmail({
        projectId: auth.projectId,
        contactId: contact.id,
        subject: renderedSubject,
        body: renderedBody,
        from: emailFrom,
        fromName: emailFromName,
        toName: recipient.name,
        replyTo: replyToEmail,
        headers: headers || undefined,
        attachments: attachments || undefined,
        templateId: templateId,
      });

      emailResults.push({
        contact: {
          id: contact.id,
          email: contact.email,
        },
        email: email.id,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        emails: emailResults,
        timestamp: timestamp.toISOString(),
      },
    });
  }

  /**
   * POST /v1/identify
   *
   * The authoritative entry point for contact identity (docs/issues/02-identify-resolution-and-binding.md).
   * Given an external id and resolves against it first, then against email. Four cases:
   * - Neither found -> creates the contact (a lead, if no email is given).
   * - Found by external id -> updates that row, including adopting a changed/first-time email
   *   onto the SAME row (fixes the email-change defect: tags, sequence position, and history
   *   are never abandoned).
   * - Found by email with a null external id -> binds the external id onto that contact. This
   *   is the normal path for every contact already in Plunk -- there is no backfill.
   * - Found by email with a DIFFERENT non-null external id -> refuses with 409. Two identified
   *   people are never silently merged.
   *
   * It can be tagged, segmented, and tracked like any other contact; a contact with no email is
   * a lead, never selected into a mailable audience (see apps/api/src/database/contact-filters.ts).
   *
   * Requires a SECRET key, not a public key -- unlike /v1/track, this is meant to be called from
   * a trusted backend, not client-side code, since it establishes identity.
   *
   * Request body:
   * - externalId: string (required) - Caller-supplied stable id for this person, unique per project
   * - email: string (optional) - Contact email. Normalized (trimmed, lowercased) before lookup/storage.
   * - subscribed: boolean (optional) - Contact subscription status (only updates if explicitly specified)
   * - data: object (optional) - Contact data (identify is the only path that writes persistent contact attributes)
   * - tags: string[] (optional) - Tag names to apply (auto-created if missing). Applied as a
   *   direct write -- does not emit `tag.added` and does not trigger sequence auto-enrolment.
   *
   * Response:
   * - success: boolean
   * - data: object with contact ID and timestamp
   *
   * Errors:
   * - 409 Conflict: the email already belongs to a different identified contact
   */
  @Post('identify')
  @Middleware([requireSecretKey, trackRateLimit, idempotency])
  @CatchAsync
  public async identify(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const {externalId, email, subscribed, data, tags} = ActionSchemas.identify.parse(req.body);

    const contact = await ContactService.identify(
      auth.projectId,
      externalId,
      data as Record<string, unknown> | undefined,
      subscribed,
      email,
      tags,
    );

    return res.status(200).json({
      success: true,
      data: {
        contact: contact.id,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * POST /v1/verify
   * Verify an email address
   *
   * Request body:
   * - email: string (required) - Email address to verify
   *
   * Response:
   * - success: boolean
   * - data: object with verification results
   *   - email: string - Email address that was verified
   *   - valid: boolean - Whether the email appears to be valid
   *   - isDisposable: boolean - Whether the email is from a disposable domain
   *   - hasMxRecords: boolean - Whether the domain has MX records configured
   *   - suggestedEmail?: string - Suggested correction if typo detected
   *   - reasons: string[] - Array of reasons describing the verification results
   *
   * Example:
   * {
   *   email: "user@gmial.com"
   * }
   *
   * Response:
   * {
   *   success: true,
   *   data: {
   *     email: "user@gmial.com",
   *     valid: false,
   *     isDisposable: false,
   *     hasMxRecords: false,
   *     suggestedEmail: "user@gmail.com",
   *     reasons: [
   *       "Possible typo detected, did you mean user@gmail.com?",
   *       "Domain does not exist or has no MX records"
   *     ]
   *   }
   * }
   */
  @Post('verify')
  @Middleware([requireSecretKey])
  @CatchAsync
  public async verify(req: Request, res: Response, _next: NextFunction) {
    // Zod validation - errors automatically handled by global error handler
    const {email} = ActionSchemas.verify.parse(req.body);

    // Verify the email address
    const verificationResult = await EmailVerificationService.verifyEmail(email);

    return res.status(200).json({
      success: true,
      data: verificationResult,
    });
  }
}
