import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import cors from 'cors';
import {json, raw} from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import signale from 'signale';

import {
  DASHBOARD_URI,
  GITHUB_OAUTH_ENABLED,
  GOOGLE_OAUTH_ENABLED,
  LANDING_URI,
  NODE_ENV,
  PLUNK_ENABLED,
  PORT,
  RATE_LIMIT_CONTACTS_PER_SECOND,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_SEND_PER_SECOND,
  RATE_LIMIT_TRACK_PER_SECOND,
  S3_ENABLED,
  SMTP_ENABLED,
  STRIPE_ENABLED,
  TRACKING_TOGGLE_ENABLED,
  WIKI_URI,
} from './app/constants.js';
import {widgetRouter} from './app/widget.js';
import {Actions} from './controllers/Actions.js';
import {Activity} from './controllers/Activity.js';
import {Analytics} from './controllers/Analytics.js';
import {Auth} from './controllers/Auth.js';
import {Campaigns} from './controllers/Campaigns.js';
import {ChatAttachments} from './controllers/ChatAttachments.js';
import {Contacts} from './controllers/Contacts.js';
import {Conversations} from './controllers/Conversations.js';
import {Domains} from './controllers/Domains.js';
import {Events} from './controllers/Events.js';
import {Messenger} from './controllers/Messenger.js';
import {Oauth} from './controllers/Oauth/index.js';
import {Projects} from './controllers/Projects.js';
import {Segments} from './controllers/Segments.js';
import {Sequences} from './controllers/Sequences.js';
import {Tags} from './controllers/Tags.js';
import {Templates} from './controllers/Templates.js';
import {Unsubscribe} from './controllers/Unsubscribe.js';
import {Uploads} from './controllers/Uploads.js';
import {Users} from './controllers/Users.js';
import {Webhooks} from './controllers/Webhooks.js';
import {Workflows} from './controllers/Workflows.js';
import {Config} from './controllers/Config.js';
import {prisma} from './database/prisma.js';
import {HttpException} from './exceptions/index.js';
import {
  apiRequestCleanupQueue,
  campaignStatsSweepQueue,
  domainVerificationQueue,
  cardVerificationSweepQueue,
  emailBodyCleanupQueue,
  idempotencyKeyCleanupQueue,
  segmentCountQueue,
  sequenceSweepQueue,
  snoozeSweepQueue,
} from './services/QueueService.js';
import * as S3Service from './services/S3Service.js';
import {requestIdMiddleware} from './middleware/requestId.js';
import {errorHandler} from './middleware/errorHandler.js';
import {databaseRequestLogger} from './middleware/requestLogger.js';
import {requestLogger} from './utils/logger.js';

const server = new (class extends Server {
  public constructor() {
    super();

    // Specify that we need raw json for the webhook
    this.app.use('/webhooks/incoming/stripe', raw({type: 'application/json'}));

    // Set the content-type to JSON for any request coming from AWS SNS
    this.app.use(function (req, res, next) {
      if (req.get('x-amz-sns-message-type')) {
        req.headers['content-type'] = 'application/json';
      }
      next();
    });

    // Parse the rest of our application as json
    this.app.use(json({limit: '50mb'}));
    this.app.use(cookies());
    this.app.use(helmet());

    // Add request ID to all requests for tracking
    this.app.use(requestIdMiddleware);

    // Log all requests and responses with request ID (console/file logs)
    this.app.use(requestLogger);

    // Log all requests to database for historical tracking and analytics
    this.app.use(databaseRequestLogger);

    // Build allowed origins from environment variables
    const allowedOrigins =
      NODE_ENV === 'development'
        ? [/.*\.localhost:1000/, DASHBOARD_URI, LANDING_URI, WIKI_URI]
        : [DASHBOARD_URI, LANDING_URI, WIKI_URI];

    // Public API endpoints that should allow all origins
    const publicApiPaths = ['/v1', '/v1/track', '/v1/send'];

    // Log CORS configuration on startup
    signale.info('CORS configuration', {
      environment: NODE_ENV,
      allowedOrigins: allowedOrigins.map(o => (o instanceof RegExp ? o.toString() : o)),
      publicApiPaths,
    });

    // Apply restrictive CORS to all routes EXCEPT public API endpoints
    this.app.use((req, res, next) => {
      // Check if this is a public API endpoint
      const isPublicApi = publicApiPaths.some(path => req.path === path || req.path.startsWith(path + '/'));

      if (isPublicApi) {
        // For public API endpoints, allow all origins
        res.set({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        // Handle preflight
        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        return next();
      }

      // For other endpoints, apply restrictive CORS
      cors({
        origin: (origin, callback) => {
          // Allow requests with no origin (e.g., mobile apps, curl, server-to-server)
          if (!origin) {
            return callback(null, true);
          }

          // Check if origin matches any allowed origin (string or regex)
          const isAllowed = allowedOrigins.some(allowed => {
            if (allowed instanceof RegExp) {
              return allowed.test(origin);
            }
            return allowed === origin;
          });

          if (isAllowed) {
            callback(null, true);
          } else {
            // Log CORS rejection with helpful information
            signale.warn('CORS request rejected', {
              origin,
              allowedOrigins: allowedOrigins.map(o => (o instanceof RegExp ? o.toString() : o)),
              hint: 'If using HTTPS, ensure USE_HTTPS=true is set in your environment variables',
            });
            // Reject the CORS request by passing false (don't send CORS headers)
            callback(null, false);
          }
        },
        credentials: true,
      })(req, res, next);
    });

    this.app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'short'));

    this.app.use('/widget', widgetRouter());

    this.addControllers([
      new Actions(),
      new Activity(),
      new Analytics(),
      new Auth(),
      new Campaigns(),
      new ChatAttachments(),
      new Oauth(),
      new Users(),
      new Contacts(),
      new Conversations(),
      new Domains(),
      new Projects(),
      new Segments(),
      new Sequences(),
      new Tags(),
      new Templates(),
      new Unsubscribe(),
      new Uploads(),
      new Webhooks(),
      new Workflows(),
      new Events(),
      new Messenger(),
      new Config(),
    ]);

    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        time: Date.now(),
        environment: NODE_ENV,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      });
    });

    this.app.get('/', (_, res) => res.redirect(LANDING_URI));

    this.app.use('*', () => {
      throw new HttpException(404, 'Unknown route');
    });
  }
})();

server.app.use(errorHandler);

// Global error handlers to prevent server crashes
process.on('unhandledRejection', (reason, promise) => {
  signale.error('Unhandled Promise Rejection:', reason);
  signale.error('Promise:', promise);
  // Don't exit the process - just log the error
});

process.on('uncaughtException', error => {
  signale.error('Uncaught Exception:', error);
  // Don't exit the process - just log the error
});

void prisma.$connect().then(async () => {
  server.app.listen(PORT, '0.0.0.0', () => signale.success('[HTTPS] Ready on', PORT));

  // Feature matrix
  const features = [
    {
      name: 'Billing (Stripe)',
      enabled: STRIPE_ENABLED,
      details: STRIPE_ENABLED ? 'Stripe billing enabled' : 'No Stripe keys configured',
    },
    {
      name: 'File uploads (S3)',
      enabled: S3_ENABLED,
      details: S3_ENABLED ? 'S3 storage enabled' : 'S3 credentials missing',
    },
    {name: 'SMTP relay', enabled: SMTP_ENABLED, details: SMTP_ENABLED ? 'SMTP server enabled' : 'SMTP disabled'},
    {
      name: 'OAuth - GitHub',
      enabled: GITHUB_OAUTH_ENABLED,
      details: GITHUB_OAUTH_ENABLED ? 'GitHub login enabled' : 'GitHub OAuth not configured',
    },
    {
      name: 'OAuth - Google',
      enabled: GOOGLE_OAUTH_ENABLED,
      details: GOOGLE_OAUTH_ENABLED ? 'Google login enabled' : 'Google OAuth not configured',
    },
    {
      name: 'Tracking toggle',
      enabled: TRACKING_TOGGLE_ENABLED,
      details: TRACKING_TOGGLE_ENABLED
        ? 'Per-project tracking toggle enabled'
        : 'Always tracking or always no-tracking',
    },
    {
      name: 'Platform emails',
      enabled: PLUNK_ENABLED,
      details: PLUNK_ENABLED ? 'Platform email notifications enabled' : 'PLUNK_API_KEY not configured',
    },
    {
      name: 'API rate limiting',
      enabled: RATE_LIMIT_ENABLED,
      details: RATE_LIMIT_ENABLED
        ? `track ${RATE_LIMIT_TRACK_PER_SECOND}/s, send ${RATE_LIMIT_SEND_PER_SECOND}/s, contacts ${RATE_LIMIT_CONTACTS_PER_SECOND}/s`
        : 'Disabled via RATE_LIMIT_ENABLED=false',
    },
  ];

  const rows = features.map(f => ({
    Feature: f.name,
    Enabled: f.enabled ? '✅' : '❌',
  }));

  console.table(rows);

  if (S3_ENABLED) {
    try {
      await S3Service.initializeBucket();
      await S3Service.initializePrivateBucket();
    } catch (error) {
      signale.error('[S3] Failed to initialize bucket:', error);
      signale.warn('[S3] File uploads may not work properly');
    }
  }

  // Set up repeatable job for domain verification (BullMQ)
  // Run every 5 minutes to check domain verification status with AWS SES
  await domainVerificationQueue.add(
    'check-domain-verification',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'domain-verification-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Domain verification scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for segment count updates (BullMQ)
  // Run every 5 minutes to compute membership changes and trigger events
  await segmentCountQueue.add(
    'update-segment-counts',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'segment-count-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Segment count updater scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for API request log cleanup (BullMQ)
  // Run daily at 3 AM to clean up old request logs
  await apiRequestCleanupQueue.add(
    'cleanup-old-requests',
    {},
    {
      repeat: {
        pattern: '0 3 * * *', // Daily at 3 AM
      },
      jobId: 'api-request-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] API request cleanup scheduled (BullMQ repeatable job, runs daily at 3 AM)');

  // Set up repeatable job for expired idempotency key cleanup (BullMQ)
  // Runs hourly: expiry is what makes a key reusable, so the sweep should track the TTL
  await idempotencyKeyCleanupQueue.add(
    'cleanup-expired-keys',
    {},
    {
      repeat: {
        pattern: '0 * * * *', // Hourly, on the hour
      },
      jobId: 'idempotency-key-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Idempotency key cleanup scheduled (BullMQ repeatable job, runs hourly)');

  // Set up repeatable job for email body cleanup (BullMQ)
  // Run daily at 4 AM, offset from the API request cleanup so the two don't overlap
  await emailBodyCleanupQueue.add(
    'cleanup-old-email-bodies',
    {},
    {
      repeat: {
        pattern: '0 4 * * *', // Daily at 4 AM
      },
      jobId: 'email-body-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Email body cleanup scheduled (BullMQ repeatable job, runs daily at 4 AM)');

  // Set up repeatable job for card verification reconciliation (BullMQ)
  // Every 15 minutes: a project stuck without a verification verdict is still able to send,
  // so the window between the stall and someone noticing is the exposure being closed.
  await cardVerificationSweepQueue.add(
    'sweep-stalled-verifications',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *', // Every 15 minutes
      },
      jobId: 'card-verification-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Card verification sweep scheduled (BullMQ repeatable job, runs every 15 minutes)');

  // Set up repeatable job for campaign stats reconciliation (BullMQ)
  // Every 2 minutes: opens and clicks arrive long after a campaign finalizes, and the counters
  // the stats endpoint reads are only written by a reconcile. This is the lag between an event
  // landing on the email row and the campaign reporting it.
  await campaignStatsSweepQueue.add(
    'sweep-dirty-campaign-stats',
    {},
    {
      repeat: {
        pattern: '*/2 * * * *', // Every 2 minutes
      },
      jobId: 'campaign-stats-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Campaign stats sweep scheduled (BullMQ repeatable job, runs every 2 minutes)');

  // Set up repeatable job for sequence delivery (BullMQ)
  // Every 5 minutes: sends each due contact's next unsent published sequence step.
  // The sent-set model makes every run idempotent, so cadence only affects delay precision.
  await sequenceSweepQueue.add(
    'sequence-sweep',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'sequence-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Sequence sweep scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for waking snoozed conversations (BullMQ)
  // Every minute: a snooze is set to a time of day, so a conversation reappears within a minute of it.
  await snoozeSweepQueue.add(
    'snooze-sweep',
    {},
    {
      repeat: {
        pattern: '* * * * *', // Every minute
      },
      jobId: 'snooze-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Snooze sweep scheduled (BullMQ repeatable job, runs every minute)');
});
