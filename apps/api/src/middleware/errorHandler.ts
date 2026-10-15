import type {NextFunction, Request, Response} from 'express';
import {ZodError} from 'zod';

import {ErrorCode, type FieldError, HttpException, ValidationError} from '../exceptions/index.js';
import {logger} from '../utils/logger.js';

/**
 * Standardized error response format
 */
interface ErrorResponse {
  success: false;
  error: {
    code: string; // Machine-readable error code (e.g., "VALIDATION_ERROR")
    message: string; // Human-readable error message
    statusCode: number; // HTTP status code
    requestId?: string; // Request ID for tracking
    errors?: FieldError[]; // Field-level validation errors
    details?: Record<string, unknown>; // Additional error context
    suggestion?: string; // Helpful suggestion for fixing the error
  };
  timestamp: string; // ISO timestamp
}

export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId = res.locals.requestId as string | undefined;

  // Handle JSON parsing errors (from express.json() middleware)
  if (error instanceof SyntaxError && 'body' in error) {
    const statusCode = 400;

    logger.warn(
      'JSON parsing failed',
      {
        endpoint: `${req.method} ${req.path}`,
        contentType: req.get('content-type'),
      },
      res,
    );

    const response: ErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid JSON in request body',
        statusCode,
        requestId,
        suggestion: 'Ensure your request body is valid JSON and Content-Type header is set to "application/json".',
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const fieldErrors: FieldError[] = error.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message,
      code: err.code,
      received: err.code !== 'invalid_type' ? undefined : 'received' in err ? err.received : undefined,
    }));

    const statusCode = 422;

    // Create helpful suggestions based on common validation errors
    let suggestion = 'Please check the API documentation for the correct request format.';
    if (fieldErrors.some(e => e.code === 'invalid_type')) {
      suggestion =
        'One or more fields have incorrect types. Check that strings are quoted, numbers are unquoted, and booleans are true/false.';
    } else if (fieldErrors.some(e => e.message.includes('required'))) {
      suggestion = 'Required fields are missing. Ensure all required fields are included in your request.';
    }

    // Log validation errors with structured logging
    logger.warn(
      'Validation failed',
      {
        endpoint: `${req.method} ${req.path}`,
        fieldCount: fieldErrors.length,
        fields: fieldErrors.map(e => e.field),
      },
      res,
    );

    const response: ErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Request validation failed',
        statusCode,
        requestId,
        errors: fieldErrors,
        suggestion,
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle custom HTTP exceptions
  if (error instanceof HttpException) {
    const statusCode = error.code;
    const errorCode = error.errorCode || ErrorCode.INTERNAL_SERVER_ERROR;

    // Extract validation errors if this is a ValidationError
    const validationError = error instanceof ValidationError ? error : null;

    // Log based on severity with structured logging
    if (statusCode >= 500) {
      logger.error(
        error.message,
        error,
        {
          endpoint: `${req.method} ${req.path}`,
          errorCode,
          statusCode,
        },
        res,
      );
    } else if (statusCode >= 400) {
      logger.warn(
        error.message,
        {
          endpoint: `${req.method} ${req.path}`,
          errorCode,
          statusCode,
        },
        res,
      );
    }

    // Generate helpful suggestions based on error type
    let suggestion: string | undefined;
    switch (errorCode) {
      case ErrorCode.INVALID_API_KEY:
        suggestion = 'Verify your API key is correct and starts with "sk_" for secret keys or "pk_" for public keys.';
        break;
      case ErrorCode.MISSING_AUTH:
        suggestion = 'Include an Authorization header with format: "Authorization: Bearer YOUR_API_KEY"';
        break;
      case ErrorCode.FORBIDDEN:
        suggestion =
          'This action requires additional permissions. Check that you have access to this resource or contact support.';
        break;
      case ErrorCode.TEMPLATE_NOT_FOUND:
        suggestion =
          'Ensure the template ID is correct and belongs to your project. You can list available templates via the API.';
        break;
      case ErrorCode.VALIDATION_ERROR:
        suggestion = 'Check the "errors" array for specific field-level validation issues.';
        break;
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        suggestion = 'You have exceeded the rate limit. Wait a moment before retrying, or upgrade your plan.';
        break;
      case ErrorCode.UPGRADE_REQUIRED:
        suggestion = 'This feature requires a higher plan. Visit your dashboard to upgrade.';
        break;
      case ErrorCode.PROJECT_DISABLED:
        suggestion = 'Your project has been disabled. Contact support for assistance.';
        break;
      case ErrorCode.IDEMPOTENCY_KEY_REUSED:
        suggestion =
          'This Idempotency-Key was already used, so the request was refused rather than performed twice. Generate a new key for a genuinely new request.';
        break;
    }

    const response: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: error.message,
        statusCode,
        requestId,
        errors: validationError?.errors,
        details: error.details,
        suggestion,
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle unexpected errors (not HttpException)
  const statusCode = 500;
  logger.error(
    'Unexpected error occurred',
    error,
    {
      endpoint: `${req.method} ${req.path}`,
    },
    res,
  );

  const response: ErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
      statusCode,
      requestId,
      suggestion: 'This is an internal server error. Please contact support with the request ID if the issue persists.',
    },
    timestamp: new Date().toISOString(),
  };

  res.status(statusCode).json(response);
}
