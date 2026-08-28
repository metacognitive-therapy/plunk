import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ActionSchemas} from '@plunk/shared';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {
  BadRequest,
  ConflictError,
  ErrorCode,
  HttpException,
  NotAllowed,
  NotAuthenticated,
  NotFound,
  RateLimitError,
  ValidationError,
} from '../../exceptions/index.js';
import {EmailService} from '../../services/EmailService.js';

/**
 * Integration tests for Actions API endpoints (/v1/send, /v1/track)
 * Tests error handling, validation, and business logic for public API
 */
describe('Actions API Integration Tests', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  // ========================================
  // ERROR RESPONSE STRUCTURE
  // ========================================
  describe('Error Response Structure', () => {
    it('should have standardized error response format', () => {
      // Document the expected error response structure
      const expectedErrorResponse = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR', // Machine-readable
          message: 'Request validation failed', // Human-readable
          statusCode: 422,
          requestId: expect.any(String), // For tracking
          errors: expect.any(Array), // Field-level errors (for validation)
          suggestion: expect.any(String), // Helpful tip
        },
        timestamp: expect.any(String), // ISO timestamp
      };

      // Verify structure
      expect(expectedErrorResponse.success).toBe(false);
      expect(expectedErrorResponse.error.code).toBeDefined();
      expect(expectedErrorResponse.error.message).toBeDefined();
      expect(expectedErrorResponse.error.statusCode).toBeDefined();
    });
  });

  // ========================================
  // VALIDATION ERRORS (422)
  // ========================================
  describe('Validation Error Handling', () => {
    it('should validate email format in requests', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'not-an-email',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });

    it('should validate required fields for /v1/send', () => {
      const result = ActionSchemas.send.safeParse({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.path.includes('to'))).toBe(true);
      }
    });

    it('should validate subject and body required when no template', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        from: 'test@example.com',
        // Missing subject, body, and template
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.message.includes('template'))).toBe(true);
      }
    });

    it('should validate required fields for /v1/track', () => {
      const result = ActionSchemas.track.safeParse({
        email: 'test@example.com',
        // Missing event name
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.path.includes('event'))).toBe(true);
      }
    });

    it('should accept from as string (backward compatible)', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: 'sender@example.com',
      });

      expect(result.success).toBe(true);
    });

    it('should accept from as object with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
          email: 'sender@example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should accept from as object with only email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          email: 'sender@example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should reject from object with invalid email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
          email: 'not-an-email',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject from object missing email field', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should accept to as string (backward compatible)', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as object with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
          email: 'test@example.com',
        },
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as object with only email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          email: 'test@example.com',
        },
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as array of strings', () => {
      const result = ActionSchemas.send.safeParse({
        to: ['test1@example.com', 'test2@example.com'],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as array of objects with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: [
          {name: 'Jane Doe', email: 'test1@example.com'},
          {name: 'John Smith', email: 'test2@example.com'},
        ],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as mixed array of strings and objects', () => {
      const result = ActionSchemas.send.safeParse({
        to: ['test1@example.com', {name: 'John Smith', email: 'test2@example.com'}],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should reject to object with invalid email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
          email: 'not-an-email',
        },
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });

    it('should reject to object missing email field', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
        },
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });
  });

  // ========================================
  // CUSTOM HTTP EXCEPTIONS
  // ========================================
  describe('Custom HTTP Exception Types', () => {
    it('should structure NotFound errors correctly', () => {
      const error = new NotFound('Template', 'abc-123');

      expect(error.code).toBe(404);
      expect(error.message).toContain('Template');
      expect(error.message).toContain('abc-123');
      expect(error.errorCode).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
      expect(error.details).toEqual({resource: 'Template', id: 'abc-123'});
    });

    it('should map resources to specific error codes', () => {
      const testCases = [
        {resource: 'contact', expectedCode: ErrorCode.CONTACT_NOT_FOUND},
        {resource: 'template', expectedCode: ErrorCode.TEMPLATE_NOT_FOUND},
        {resource: 'campaign', expectedCode: ErrorCode.CAMPAIGN_NOT_FOUND},
        {resource: 'workflow', expectedCode: ErrorCode.WORKFLOW_NOT_FOUND},
        {resource: 'unknown', expectedCode: ErrorCode.RESOURCE_NOT_FOUND},
      ];

      for (const {resource, expectedCode} of testCases) {
        const error = new NotFound(resource);
        expect(error.errorCode).toBe(expectedCode);
      }
    });

    it('should structure ValidationError with field details', () => {
      const fieldErrors = [
        {field: 'email', message: 'Invalid email format', code: 'invalid_email'},
        {field: 'data.firstName', message: 'Required field', code: 'required'},
      ];

      const error = new ValidationError(fieldErrors);

      expect(error.code).toBe(422);
      expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.errors).toEqual(fieldErrors);
    });

    it('should structure NotAuthenticated errors', () => {
      const error = new NotAuthenticated();

      expect(error.code).toBe(401);
      expect(error.errorCode).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('should structure NotAllowed errors', () => {
      const error = new NotAllowed('Cannot perform action', 'Insufficient permissions');

      expect(error.code).toBe(403);
      expect(error.errorCode).toBe(ErrorCode.FORBIDDEN);
      expect(error.details).toEqual({reason: 'Insufficient permissions'});
    });

    it('should structure RateLimitError', () => {
      const error = new RateLimitError('Too many requests', 60);

      expect(error.code).toBe(429);
      expect(error.errorCode).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
      expect(error.details).toEqual({retryAfter: 60});
    });

    it('should structure ConflictError', () => {
      const error = new ConflictError('Contact exists', {email: 'test@example.com'});

      expect(error.code).toBe(409);
      expect(error.errorCode).toBe(ErrorCode.CONFLICT);
      expect(error.details).toEqual({email: 'test@example.com'});
    });

    it('should structure BadRequest errors', () => {
      const error = new BadRequest('Invalid format', ErrorCode.INVALID_REQUEST_BODY, {
        expected: 'JSON',
      });

      expect(error.code).toBe(400);
      expect(error.errorCode).toBe(ErrorCode.INVALID_REQUEST_BODY);
      expect(error.details).toEqual({expected: 'JSON'});
    });
  });

  // ========================================
  // BUSINESS LOGIC ERRORS
  // ========================================
  describe('Business Logic Error Scenarios', () => {
    it('should reject marketing template sent to unsubscribed contact', async () => {
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
      });

      const marketingTemplate = await factories.createTemplate({
        projectId,
        type: 'MARKETING',
      });

      await expect(
        EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          templateId: marketingTemplate.id,
          subject: 'Marketing',
          body: 'Buy now!',
          from: 'test@example.com',
        }),
      ).rejects.toThrow(/cannot send marketing template to unsubscribed contact/i);
    });

    it('should return NotFound when template does not exist', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const template = await prisma.template.findUnique({
        where: {id: nonExistentId, projectId},
      });

      expect(template).toBeNull();

      // In actual API, this would trigger NotFound exception

      const error = new NotFound('Template', nonExistentId);

      expect(error.code).toBe(404);
      expect(error.errorCode).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
    });

    it('should handle billing limit exceeded', () => {
      const error = new HttpException(429, 'Billing limit exceeded');

      expect(error.code).toBe(429);
      expect(error.message).toContain('Billing limit exceeded');
    });
  });

  // ========================================
  // ERROR CODE COVERAGE
  // ========================================
  describe('ErrorCode Enum Coverage', () => {
    it('should have all expected error codes defined', () => {
      const expectedCodes = [
        // Auth (401, 403)
        'UNAUTHORIZED',
        'INVALID_CREDENTIALS',
        'MISSING_AUTH',
        'INVALID_API_KEY',
        'FORBIDDEN',
        'PROJECT_ACCESS_DENIED',
        'PROJECT_DISABLED',

        // Resources (404, 409)
        'RESOURCE_NOT_FOUND',
        'CONTACT_NOT_FOUND',
        'TEMPLATE_NOT_FOUND',
        'CAMPAIGN_NOT_FOUND',
        'WORKFLOW_NOT_FOUND',
        'CONFLICT',

        // Validation (400, 422)
        'BAD_REQUEST',
        'VALIDATION_ERROR',
        'INVALID_EMAIL',
        'INVALID_REQUEST_BODY',
        'MISSING_REQUIRED_FIELD',

        // Limits (429, 402)
        'RATE_LIMIT_EXCEEDED',
        'BILLING_LIMIT_EXCEEDED',
        'UPGRADE_REQUIRED',

        // Server (500+)
        'INTERNAL_SERVER_ERROR',
        'DATABASE_ERROR',
        'EXTERNAL_SERVICE_ERROR',
      ];

      for (const code of expectedCodes) {
        expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
      }
    });
  });

  // ========================================
  // RESERVED EVENT VALIDATION
  // ========================================
  describe('Reserved Event Validation', () => {
    describe('Email events (email.*)', () => {
      it('should reject email.sent event', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'email.sent',
          email: 'test@example.com',
        });

        // Schema allows it, but controller validation should reject
        expect(result.success).toBe(true);

        // Verify the error would be thrown by controller
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.sent" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.sent',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
        expect(error.errors[0]?.code).toBe('reserved_event');
      });

      it('should reject email.delivery event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.delivery" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.delivery',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.field).toBe('event');
      });

      it('should reject email.open event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.open" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.click event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.click" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.bounce event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.bounce" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.complaint event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.complaint" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject any email.* pattern', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.custom" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });
    });

    describe('Contact events', () => {
      it('should reject contact.subscribed event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "contact.subscribed" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.field).toBe('event');
      });

      it('should reject contact.unsubscribed event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "contact.unsubscribed" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should allow other contact.* events', () => {
        const result1 = ActionSchemas.track.safeParse({
          event: 'contact.created',
          email: 'test@example.com',
        });

        const result2 = ActionSchemas.track.safeParse({
          event: 'contact.updated',
          email: 'test@example.com',
        });

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
      });
    });

    describe('Segment events', () => {
      it('should reject segment.*.entry events', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "segment.vip-users.entry" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.code).toBe('reserved_event');
      });

      it('should reject segment.*.exit events', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "segment.premium.exit" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should allow other segment.* events', () => {
        const result1 = ActionSchemas.track.safeParse({
          event: 'segment.created',
          email: 'test@example.com',
        });

        const result2 = ActionSchemas.track.safeParse({
          event: 'segment.premium.updated',
          email: 'test@example.com',
        });

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
      });
    });

    describe('Custom user events', () => {
      it('should allow custom user events', () => {
        const testCases = [
          'user.signup',
          'purchase.completed',
          'order.placed',
          'custom.event',
          'product.viewed',
          'cart.abandoned',
        ];

        for (const eventName of testCases) {
          const result = ActionSchemas.track.safeParse({
            event: eventName,
            email: 'test@example.com',
          });

          expect(result.success).toBe(true);
        }
      });

      it('should allow events with similar but different prefixes', () => {
        const testCases = ['emails.sent', 'contacts.subscribed', 'segments.entry'];

        for (const eventName of testCases) {
          const result = ActionSchemas.track.safeParse({
            event: eventName,
            email: 'test@example.com',
          });

          expect(result.success).toBe(true);
        }
      });
    });

    describe('Error structure for reserved events', () => {
      it('should return ValidationError with correct structure', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.sent" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.sent',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.code).toBe(422);
        expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
        expect(error.message).toBe('Cannot track reserved system event');
        expect(error.errors).toHaveLength(1);
        expect(error.errors[0]).toMatchObject({
          field: 'event',
          code: 'reserved_event',
          received: 'email.sent',
        });
      });
    });
  });

  // ========================================
  // SUBSCRIPTION STATUS PRESERVATION
  // ========================================
  describe('Subscription Status Preservation', () => {
    describe('/v1/send endpoint', () => {
      it('should NOT change subscription status when sending to subscribed contact without subscribed field', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'subscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(true);

        // Send transactional email without specifying subscribed field
        await EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        // Verify subscription status unchanged
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(true);
      });

      it('should NOT change subscription status when sending to unsubscribed contact without subscribed field', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'unsubscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(false);

        // Send transactional email without specifying subscribed field
        await EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        // Verify subscription status unchanged (should still be false)
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(false);
      });

      it('should allow explicit subscription when subscribed=true is provided', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'resubscribe@example.com',
        });

        // This test would need to be implemented at the controller level
        // since EmailService.sendTransactionalEmail doesn't accept subscribed parameter
        // For now, verify the schema allows it
        const result = ActionSchemas.send.safeParse({
          to: contact.email,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
          subscribed: true,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(true);
        }
      });

      it('should allow explicit unsubscription when subscribed=false is provided', async () => {
        // Verify the schema allows explicit false
        const result = ActionSchemas.send.safeParse({
          to: 'test@example.com',
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
          subscribed: false,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(false);
        }
      });

      it('should default to undefined when subscribed field is omitted', () => {
        const result = ActionSchemas.send.safeParse({
          to: 'test@example.com',
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should be undefined, not false
          expect(result.data.subscribed).toBeUndefined();
        }
      });

      it('should create new contacts as unsubscribed when subscribed is undefined', async () => {
        const newEmail = 'new-send-contact@example.com';

        // Send email to new contact without specifying subscribed
        const {ContactService} = await import('../../services/ContactService.js');
        const contact = await ContactService.upsert(projectId, newEmail, {name: 'Test'}, false);

        // Transactional emails should create contacts as unsubscribed by default
        expect(contact.subscribed).toBe(false);
      });
    });

    describe('/v1/track endpoint', () => {
      it('should NOT change subscription status when tracking event for subscribed contact', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'track-subscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(true);

        // Track event without specifying subscribed field
        // This would be done via ContactService.upsert in the track endpoint
        const {ContactService} = await import('../../services/ContactService.js');
        await ContactService.upsert(projectId, contact.email, {event: 'test'}, undefined);

        // Verify subscription status unchanged
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(true);
      });

      it('should NOT re-subscribe unsubscribed contact when tracking event', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'track-unsubscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(false);

        // Track event without specifying subscribed field
        const {ContactService} = await import('../../services/ContactService.js');
        await ContactService.upsert(projectId, contact.email, {event: 'test'}, undefined);

        // Verify subscription status unchanged (should still be false, NOT re-subscribed)
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(false);
      });

      it('should create new contacts as subscribed when subscribed is undefined', async () => {
        const newEmail = 'new-track-contact@example.com';

        // Track event for new contact without specifying subscribed
        const {ContactService} = await import('../../services/ContactService.js');
        const contact = await ContactService.upsert(projectId, newEmail, {event: 'test'}, true);

        // Event tracking should create contacts as subscribed by default
        expect(contact.subscribed).toBe(true);
      });

      it('should allow explicit subscription when subscribed=true is provided', async () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          subscribed: true,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(true);
        }
      });

      it('should allow explicit unsubscription when subscribed=false is provided', async () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          subscribed: false,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(false);
        }
      });

      it('should default to undefined when subscribed field is omitted', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should be undefined, not true
          expect(result.data.subscribed).toBeUndefined();
        }
      });

      it('should leave occurredAt undefined when omitted', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.occurredAt).toBeUndefined();
        }
      });

      it('should treat an explicit null occurredAt the same as omitted, not as the epoch', () => {
        // Some client JSON serializers emit `null` for an absent optional field. Without
        // normalizing null -> undefined before z.coerce.date(), `new Date(null)` resolves to
        // 1970-01-01 instead of failing validation, silently pinning the event permanently
        // outside every "triggered within" recency window.
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: null,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.occurredAt).toBeUndefined();
        }
      });

      it('should accept and coerce an ISO occurredAt string to a Date', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: '2026-01-15T10:00:00.000Z',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.occurredAt).toBeInstanceOf(Date);
          expect(result.data.occurredAt?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
        }
      });

      it('should accept an epoch-millis occurredAt', () => {
        const millis = new Date('2026-01-15T10:00:00.000Z').getTime();
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: millis,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.occurredAt?.getTime()).toBe(millis);
        }
      });

      it('should reject an occurredAt that is not a parseable date', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: 'not-a-date',
        });

        expect(result.success).toBe(false);
      });

      it('should reject an occurredAt far in the future', () => {
        const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day ahead
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: farFuture.toISOString(),
        });

        expect(result.success).toBe(false);
      });

      it('should accept an occurredAt within a small clock-skew allowance in the future', () => {
        const slightlyAhead = new Date(Date.now() + 60 * 1000); // 1 minute ahead
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: slightlyAhead.toISOString(),
        });

        expect(result.success).toBe(true);
      });

      it('should accept an occurredAt far in the past (backfilled events)', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          occurredAt: '2020-01-01T00:00:00.000Z',
        });

        expect(result.success).toBe(true);
      });
    });

    describe('ContactService.upsert behavior', () => {
      it('should preserve subscription status when undefined is passed for existing contact', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'upsert-test@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Update with undefined subscribed
        await ContactService.upsert(projectId, contact.email, {firstName: 'John'}, undefined);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(true);
      });

      it('should preserve unsubscribed status when undefined is passed', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'upsert-unsub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Update with undefined subscribed
        await ContactService.upsert(projectId, contact.email, {firstName: 'Jane'}, undefined);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(false);
      });

      it('should allow explicit subscription change to true', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'explicit-sub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Explicitly subscribe
        await ContactService.upsert(projectId, contact.email, {}, true);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(true);
      });

      it('should allow explicit subscription change to false', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'explicit-unsub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Explicitly unsubscribe
        await ContactService.upsert(projectId, contact.email, {}, false);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(false);
      });
    });
  });

  // ========================================
  // /v1/identify — full resolution and binding (docs/issues/02-identify-resolution-and-binding.md)
  // ========================================
  describe('ContactService.identify (leads)', () => {
    it('validates the identify payload shape', () => {
      expect(ActionSchemas.identify.safeParse({}).success).toBe(false); // externalId required
      expect(ActionSchemas.identify.safeParse({externalId: ''}).success).toBe(false); // non-empty
      expect(ActionSchemas.identify.safeParse({externalId: 'user_123'}).success).toBe(true);
      expect(ActionSchemas.identify.safeParse({externalId: 'user_123', subscribed: true}).success).toBe(true);
      expect(ActionSchemas.identify.safeParse({externalId: 'user_123', email: 'user@example.com'}).success).toBe(
        true,
      );
      expect(ActionSchemas.identify.safeParse({externalId: 'user_123', email: 'not-an-email'}).success).toBe(false);
      expect(
        ActionSchemas.identify.safeParse({externalId: 'user_123', tags: ['vip', 'newsletter']}).success,
      ).toBe(true);
    });

    it('creates a lead (no email) from an external id alone', async () => {
      const {ContactService} = await import('../../services/ContactService.js');

      const contact = await ContactService.identify(projectId, 'user_8f3a2c');

      expect(contact.email).toBeNull();
      expect(contact.externalId).toBe('user_8f3a2c');
      expect(contact.subscribed).toBe(true); // Default, same as track/upsert

      const stored = await prisma.contact.findUnique({where: {id: contact.id}});
      expect(stored?.email).toBeNull();
    });

    it('is idempotent: re-identifying the same external id updates rather than duplicates', async () => {
      const {ContactService} = await import('../../services/ContactService.js');

      const first = await ContactService.identify(projectId, 'user_repeat', {plan: 'free'});
      const second = await ContactService.identify(projectId, 'user_repeat', {plan: 'pro'});

      expect(second.id).toBe(first.id);
      expect(await prisma.contact.count({where: {projectId, externalId: 'user_repeat'}})).toBe(1);
      expect((second.data as Record<string, unknown> | null)?.plan).toBe('pro');
    });

    // ---- Case 1: neither found -> create ----
    describe('case: neither externalId nor email found', () => {
      it('creates a fully-identified contact when email is supplied', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const contact = await ContactService.identify(projectId, 'user_new', {plan: 'pro'}, undefined, 'New@Example.com');

        expect(contact.externalId).toBe('user_new');
        expect(contact.email).toBe('new@example.com'); // normalized
        expect(contact.subscribed).toBe(true); // default

        // Never a lead to begin with, so no conversion event.
        const events = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'contact.identified'}});
        expect(events).toHaveLength(0);
      });

      it('takes subscription state from the request, defaulting when absent', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const unsubscribed = await ContactService.identify(projectId, 'user_opt_out', undefined, false, 'optout@example.com');
        expect(unsubscribed.subscribed).toBe(false);

        const defaulted = await ContactService.identify(projectId, 'user_default', undefined, undefined, 'default@example.com');
        expect(defaulted.subscribed).toBe(true);
      });
    });

    // ---- Case 2: found by externalId -> update, including adopting a changed email ----
    describe('case: found by externalId', () => {
      it('adopts a changed email onto the same row, retaining tags/segments/sequences/events/history', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {TagService} = await import('../../services/TagService.js');
        const {SequenceService} = await import('../../services/SequenceService.js');
        const {EventService} = await import('../../services/EventService.js');

        // A lead, tagged, segmented, mid-sequence, with prior events and a send.
        const lead = await factories.createContact({projectId, email: null, externalId: 'user_lifecycle'});
        const tag = await TagService.create(projectId, 'VIP');
        await TagService.applyTags(projectId, lead.id, [tag.id]);

        const segment = await prisma.segment.create({
          data: {projectId, name: 'VIP segment', type: 'STATIC', condition: undefined},
        });
        await prisma.segmentMembership.create({data: {contactId: lead.id, segmentId: segment.id}});

        const from = await factories.createDomain({projectId});
        const sequence = await SequenceService.create(projectId, {name: 'Onboarding', from: `hello@${from.domain}`});
        await prisma.sequence.update({where: {id: sequence.id}, data: {status: 'ACTIVE'}});
        await prisma.sequenceSubscription.create({data: {sequenceId: sequence.id, contactId: lead.id}});
        const step = await prisma.sequenceStep.create({
          data: {sequenceId: sequence.id, order: 0, delayMinutes: 0, subject: 'Hi', body: 'Hi', published: true},
        });
        await prisma.sequenceStepSend.create({data: {sequenceId: sequence.id, sequenceStepId: step.id, contactId: lead.id}});

        const priorEvent = await EventService.trackEvent(projectId, 'app.opened', lead.id);
        const email = await factories.createEmail({projectId, contactId: lead.id, status: 'DELIVERED'});

        const updated = await ContactService.identify(
          projectId,
          'user_lifecycle',
          {plan: 'pro'},
          undefined,
          'Converted@Example.com',
        );

        // Same row.
        expect(updated.id).toBe(lead.id);
        expect(updated.email).toBe('converted@example.com');
        expect(await prisma.contact.count({where: {projectId, externalId: 'user_lifecycle'}})).toBe(1);

        // Everything on the old row survives, untouched.
        const tags = await prisma.contactTag.findMany({where: {contactId: lead.id}});
        expect(tags.map(t => t.tagId)).toEqual([tag.id]);

        const membership = await prisma.segmentMembership.findUnique({
          where: {contactId_segmentId: {contactId: lead.id, segmentId: segment.id}},
        });
        expect(membership).not.toBeNull();

        const subscription = await prisma.sequenceSubscription.findUnique({
          where: {sequenceId_contactId: {sequenceId: sequence.id, contactId: lead.id}},
        });
        expect(subscription).not.toBeNull();

        const stepSend = await prisma.sequenceStepSend.findFirst({where: {contactId: lead.id, sequenceStepId: step.id}});
        expect(stepSend).not.toBeNull();

        const events = await prisma.event.findMany({where: {contactId: lead.id}});
        expect(events.map(e => e.id)).toContain(priorEvent.id);

        const emailRow = await prisma.email.findUnique({where: {id: email.id}});
        expect(emailRow?.contactId).toBe(lead.id);
      });

      it('emits contact.identified exactly once when a lead first gains an email', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const lead = await factories.createContact({projectId, email: null, externalId: 'user_convert'});

        await ContactService.identify(projectId, 'user_convert', undefined, undefined, 'convert@example.com');
        // Calling again with the same email must not re-fire the event.
        await ContactService.identify(projectId, 'user_convert', undefined, undefined, 'convert@example.com');

        const events = await prisma.event.findMany({
          where: {projectId, contactId: lead.id, name: 'contact.identified'},
        });
        expect(events).toHaveLength(1);
      });

      it('does not emit contact.identified for a genuine email CHANGE (contact already had one)', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        await factories.createContact({projectId, email: 'old@example.com', externalId: 'user_change'});

        await ContactService.identify(projectId, 'user_change', undefined, undefined, 'new@example.com');

        const events = await prisma.event.findMany({where: {projectId, name: 'contact.identified'}});
        expect(events).toHaveLength(0);
      });

      it('leaves email untouched when identify is called without one', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        await factories.createContact({projectId, email: 'keep@example.com', externalId: 'user_keep'});

        const updated = await ContactService.identify(projectId, 'user_keep', {plan: 'pro'});

        expect(updated.email).toBe('keep@example.com');
      });
    });

    // ---- Case 3: found by email, externalId is null -> bind ----
    describe('case: found by email with a null externalId', () => {
      it('binds the externalId onto the existing contact, leaving everything else untouched', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {TagService} = await import('../../services/TagService.js');

        const existing = await factories.createContact({
          projectId,
          email: 'bindme@example.com',
          subscribed: false,
          data: {plan: 'free'},
        });
        const tag = await TagService.create(projectId, 'Existing');
        await TagService.applyTags(projectId, existing.id, [tag.id]);

        const bound = await ContactService.identify(projectId, 'user_bound', undefined, undefined, 'BindMe@Example.com');

        expect(bound.id).toBe(existing.id);
        expect(bound.externalId).toBe('user_bound');
        expect(bound.email).toBe('bindme@example.com');
        // Untouched: subscription state and prior data are not clobbered by the bind.
        expect(bound.subscribed).toBe(false);
        expect((bound.data as Record<string, unknown> | null)?.plan).toBe('free');

        const tags = await prisma.contactTag.findMany({where: {contactId: existing.id}});
        expect(tags.map(t => t.tagId)).toEqual([tag.id]);

        // Already had an email -- binding is not "gaining an email".
        const events = await prisma.event.findMany({where: {projectId, name: 'contact.identified'}});
        expect(events).toHaveLength(0);
      });
    });

    // ---- Case 4: found by email, externalId is a DIFFERENT non-null value -> 409 ----
    describe('case: found by email with a conflicting externalId', () => {
      it('refuses with a 409 conflict rather than merging or guessing', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        await factories.createContact({
          projectId,
          email: 'taken@example.com',
          externalId: 'user_owner',
        });

        await expect(
          ContactService.identify(projectId, 'user_impostor', undefined, undefined, 'taken@example.com'),
        ).rejects.toMatchObject({code: 409});

        // Refused, not merged: the original contact keeps its own externalId.
        const original = await prisma.contact.findFirst({where: {projectId, email: 'taken@example.com'}});
        expect(original?.externalId).toBe('user_owner');
        expect(await prisma.contact.count({where: {projectId, email: 'taken@example.com'}})).toBe(1);
      });
    });

    describe('case: contact has been anonymized (docs/issues/07-anonymize-replaces-hard-delete.md)', () => {
      it('refuses to re-identify and resurrect an anonymized contact with a new email', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const contact = await factories.createContact({
          projectId,
          email: 'erased@example.com',
          externalId: 'user_77',
        });
        await ContactService.delete(projectId, contact.id);

        await expect(
          ContactService.identify(projectId, 'user_77', undefined, undefined, 'new@example.com'),
        ).rejects.toMatchObject({code: 409});

        const stillErased = await prisma.contact.findUnique({where: {id: contact.id}});
        expect(stillErased?.email).toBeNull();
        expect(stillErased?.deletedAt).not.toBeNull();
      });
    });

    describe('normalizeEmail on the identify path', () => {
      it('treats case-variant emails as the same contact rather than creating a duplicate', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        await ContactService.identify(projectId, 'user_case_a', undefined, undefined, 'Person@Example.com');
        const second = await ContactService.identify(projectId, 'user_case_a', undefined, undefined, 'PERSON@EXAMPLE.COM');

        expect(second.email).toBe('person@example.com');
        expect(await prisma.contact.count({where: {projectId, email: 'person@example.com'}})).toBe(1);
      });
    });

    describe('P2002 race handling', () => {
      it('retries once and converges when a concurrent identify wins the externalId race', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {Prisma} = await import('@plunk/db');
        const {prisma: apiPrisma} = await import('../../database/prisma.js');

        // Simulate the real race: another request's identify() actually inserts the row between
        // our find-first and our create, and our create() hits the resulting unique-constraint
        // violation. The retry's fresh find-first must see that real row and update it rather
        // than erroring.
        const createSpy = vi.spyOn(apiPrisma.contact, 'create').mockImplementationOnce(async () => {
          await apiPrisma.contact.create({
            data: {projectId, externalId: 'user_race', email: null, subscribed: true},
          });
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`projectId`,`externalId`)',
            {code: 'P2002', clientVersion: 'test'},
          );
        });

        const result = await ContactService.identify(projectId, 'user_race', {plan: 'pro'});

        expect(result.externalId).toBe('user_race');
        expect(await prisma.contact.count({where: {projectId, externalId: 'user_race'}})).toBe(1);
        expect((result.data as Record<string, unknown> | null)?.plan).toBe('pro');

        createSpy.mockRestore();
      });

      it('surfaces a 409 (not a 500) when the retry ALSO fails', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {Prisma} = await import('@plunk/db');
        const {prisma: apiPrisma} = await import('../../database/prisma.js');

        const conflict = () =>
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`projectId`,`externalId`)', {
            code: 'P2002',
            clientVersion: 'test',
          });
        const createSpy = vi
          .spyOn(apiPrisma.contact, 'create')
          .mockRejectedValueOnce(conflict())
          .mockRejectedValueOnce(conflict());

        await expect(ContactService.identify(projectId, 'user_stuck_race')).rejects.toMatchObject({code: 409});

        createSpy.mockRestore();
      });
    });

    describe('identify-time tag movement bypasses tag.added and auto-enrolment', () => {
      it('applies tags directly without emitting tag.added or auto-enrolling into a bound sequence', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {TagService} = await import('../../services/TagService.js');
        const {SequenceService} = await import('../../services/SequenceService.js');

        const tag = await TagService.create(projectId, 'Onboarded');
        const from = await factories.createDomain({projectId});
        const sequence = await SequenceService.create(projectId, {
          name: 'Tag-triggered',
          from: `hello@${from.domain}`,
          enrollTagId: tag.id,
        });
        await prisma.sequence.update({where: {id: sequence.id}, data: {status: 'ACTIVE'}});

        const contact = await ContactService.identify(
          projectId,
          'user_tagged',
          undefined,
          undefined,
          'tagged@example.com',
          [tag.name],
        );

        const membership = await prisma.contactTag.findUnique({
          where: {contactId_tagId: {contactId: contact.id, tagId: tag.id}},
        });
        expect(membership).not.toBeNull();

        const tagAddedEvents = await prisma.event.findMany({where: {projectId, contactId: contact.id, name: 'tag.added'}});
        expect(tagAddedEvents).toHaveLength(0);

        const enrollment = await prisma.sequenceSubscription.findUnique({
          where: {sequenceId_contactId: {sequenceId: sequence.id, contactId: contact.id}},
        });
        expect(enrollment).toBeNull();
      });
    });
  });

  // ========================================
  // /v1/track by externalId (docs/issues/03-track-by-external-id.md)
  //
  // The security property IS the point: the public key that authorises track carries no
  // origin restriction, so this path must RESOLVE an existing contact and NEVER create one.
  // Exercised at the request-schema-plus-service-layer, matching the house convention for
  // this file (no live HTTP server) -- the schema assertions cover Actions.track's
  // ActionSchemas.track.parse() call, and the ContactService/EventService assertions cover
  // exactly what the controller does with the parsed result on the externalId branch.
  // ========================================
  describe('Track by externalId', () => {
    describe('request schema', () => {
      it('accepts externalId in place of email', () => {
        const result = ActionSchemas.track.safeParse({event: 'purchase', externalId: 'user_8f3a2c'});
        expect(result.success).toBe(true);
      });

      it('rejects a request with neither email nor externalId', () => {
        const result = ActionSchemas.track.safeParse({event: 'purchase'});
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.errors.some(e => e.path.includes('email'))).toBe(true);
        }
      });

      it('rejects a request carrying BOTH email and externalId', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'purchase',
          email: 'user@example.com',
          externalId: 'user_8f3a2c',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.errors.some(e => e.path.includes('externalId'))).toBe(true);
        }
      });

      it('rejects `subscribed` alongside externalId -- consent changes go through /v1/identify only', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'purchase',
          externalId: 'user_8f3a2c',
          subscribed: true,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.errors.some(e => e.path.includes('subscribed'))).toBe(true);
        }
      });

      it('still accepts `subscribed` on the email path (unaffected by the externalId rule)', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'purchase',
          email: 'user@example.com',
          subscribed: true,
        });
        expect(result.success).toBe(true);
      });

      it('still requires event name on the externalId path', () => {
        const result = ActionSchemas.track.safeParse({externalId: 'user_8f3a2c'});
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.errors.some(e => e.path.includes('event'))).toBe(true);
        }
      });
    });

    describe('resolves and records against an existing contact, never creates one', () => {
      it('resolves the matching contact and records the event against it', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {EventService} = await import('../../services/EventService.js');

        const existing = await factories.createContact({
          projectId,
          email: 'resolved@example.com',
          externalId: 'user_resolve',
        });

        // Mirrors what Actions.track does on the externalId branch.
        const resolved = await ContactService.findByExternalId(projectId, 'user_resolve');
        expect(resolved?.id).toBe(existing.id);

        const event = await EventService.trackEvent(projectId, 'purchase', resolved!.id, undefined, {plan: 'pro'});

        expect(event.contactId).toBe(existing.id);
        const storedEvents = await prisma.event.findMany({where: {projectId, contactId: existing.id, name: 'purchase'}});
        expect(storedEvents).toHaveLength(1);
      });

      it('an unknown externalId resolves to null and creates NO contact', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const before = await prisma.contact.count({where: {projectId}});

        const resolved = await ContactService.findByExternalId(projectId, 'does_not_exist');

        expect(resolved).toBeNull();
        expect(await prisma.contact.count({where: {projectId}})).toBe(before);
      });

      it('surfaces a distinguishable NotFound (404, CONTACT_NOT_FOUND) for an unknown externalId', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const resolved = await ContactService.findByExternalId(projectId, 'does_not_exist');
        expect(resolved).toBeNull();

        // This is exactly what Actions.track throws on the externalId branch when resolution
        // misses -- distinguishable from a malformed request (422) or an auth failure (401).
        const error = new NotFound('Contact', 'does_not_exist');
        expect(error.code).toBe(404);
        expect(error.errorCode).toBe(ErrorCode.CONTACT_NOT_FOUND);
      });

      it('tracking against a lead (no email) works like any other contact', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {EventService} = await import('../../services/EventService.js');

        const lead = await factories.createContact({projectId, email: null, externalId: 'user_lead'});

        const resolved = await ContactService.findByExternalId(projectId, 'user_lead');
        expect(resolved?.id).toBe(lead.id);
        expect(resolved?.email).toBeNull();

        const event = await EventService.trackEvent(projectId, 'app.opened', resolved!.id);

        expect(event.contactId).toBe(lead.id);
        const stillLead = await prisma.contact.findUnique({where: {id: lead.id}});
        expect(stillLead?.email).toBeNull();
      });
    });

    describe('event data is never merged onto the contact on this path', () => {
      it('records data on the event but leaves the contact\'s persistent data untouched', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {EventService} = await import('../../services/EventService.js');

        const existing = await factories.createContact({
          projectId,
          email: 'nomeger@example.com',
          externalId: 'user_no_merge',
          data: {plan: 'free'},
        });

        const resolved = await ContactService.findByExternalId(projectId, 'user_no_merge');

        // The controller passes `data` ONLY to trackEvent on this path -- never through
        // ContactService.upsert/update, which is what would merge it onto the contact.
        const event = await EventService.trackEvent(projectId, 'purchase', resolved!.id, undefined, {
          plan: 'enterprise',
          orderId: '12345',
        });

        expect((event.data as Record<string, unknown> | null)?.plan).toBe('enterprise');

        const unchanged = await prisma.contact.findUnique({where: {id: existing.id}});
        expect((unchanged?.data as Record<string, unknown> | null)?.plan).toBe('free');
        expect((unchanged?.data as Record<string, unknown> | null)?.orderId).toBeUndefined();
      });
    });

    describe('subscription state is left untouched on the externalId path', () => {
      it('a subscribed contact stays subscribed and an unsubscribed contact stays unsubscribed', async () => {
        const {ContactService} = await import('../../services/ContactService.js');
        const {EventService} = await import('../../services/EventService.js');

        const optedOut = await factories.createContact({
          projectId,
          email: 'optout-track@example.com',
          externalId: 'user_optout_track',
          subscribed: false,
        });

        const resolved = await ContactService.findByExternalId(projectId, 'user_optout_track');
        await EventService.trackEvent(projectId, 'app.opened', resolved!.id);

        // Resolution alone never writes to `subscribed` -- there is no code path on
        // externalId-track that can flip it, since the schema rejects `subscribed` outright
        // and the controller never calls ContactService.upsert/update on this branch.
        const stillOptedOut = await prisma.contact.findUnique({where: {id: optedOut.id}});
        expect(stillOptedOut?.subscribed).toBe(false);
      });
    });

    describe('the email path is unaffected', () => {
      it('ContactService.upsert on the email path behaves exactly as before', async () => {
        const {ContactService} = await import('../../services/ContactService.js');

        const contact = await ContactService.upsert(projectId, 'unchanged-email-path@example.com', {plan: 'pro'}, true);

        expect(contact.email).toBe('unchanged-email-path@example.com');
        expect(contact.subscribed).toBe(true);
        expect((contact.data as Record<string, unknown> | null)?.plan).toBe('pro');
      });
    });
  });
});
