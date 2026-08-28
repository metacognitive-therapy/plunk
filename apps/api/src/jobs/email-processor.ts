/**
 * Background Job: Email Processor
 * Processes individual emails from the queue (for all sources: transactional, campaign, workflow)
 *
 * This is the only send path. `EmailService.sendEmail` used to hold a second copy of it, tested
 * while this one was not, and the two had drifted; it has been removed. The behaviour those tests
 * claimed to cover -- PENDING → SENDING → SENT, the failure transition, send idempotency, and
 * attachments reaching SES -- is implemented here and is currently untested, because the job body
 * is inline in `createEmailWorker` and cannot be called without a queue. Extracting it is worth
 * doing before this logic is next changed.
 */

import {EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {DelayedError, type Job, Worker} from 'bullmq';
import signale from 'signale';

import {
  DASHBOARD_URI,
  EMAIL_RATE_LIMIT_PER_SECOND,
  EMAIL_WORKER_CONCURRENCY,
  EMAIL_WORKER_MAX_CONCURRENCY,
} from '../app/constants.js';
import {isMailableContact, isTransactionallyMailableContact} from '../database/contact-filters.js';
import {prisma} from '../database/prisma.js';
import {CampaignService} from '../services/CampaignService.js';
import {
  bodyHasListManagementLink,
  buildEmailHeaders,
  classifyEmail,
  withSourceEmail,
} from '../services/EmailHeaderService.js';
import {EmailService} from '../services/EmailService.js';
import {EventService} from '../services/EventService.js';
import {MeterService} from '../services/MeterService.js';
import {emailQueue} from '../services/QueueService.js';
import {SecurityService} from '../services/SecurityService.js';
import {getSendingQuota, sendRawEmail} from '../services/SESService.js';

/**
 * Determine the email sending rate limit (emails per second)
 * Priority: ENV variable > AWS SES quota > Safe default (14)
 */
async function getEmailRateLimit(): Promise<number> {
  const DEFAULT_RATE_LIMIT = 14; // AWS SES sandbox limit - safe default

  // If env variable is set, use it (override)
  if (EMAIL_RATE_LIMIT_PER_SECOND !== undefined) {
    signale.info(`[EMAIL-PROCESSOR] Using rate limit from environment: ${EMAIL_RATE_LIMIT_PER_SECOND} emails/second`);
    return EMAIL_RATE_LIMIT_PER_SECOND;
  }

  // Try to fetch from AWS SES
  signale.info('[EMAIL-PROCESSOR] Fetching rate limit from AWS SES...');
  const quota = await getSendingQuota();

  if (quota) {
    signale.info(
      `[EMAIL-PROCESSOR] AWS SES quota: ${quota.maxSendRate} emails/second (${quota.sentLast24Hours}/${quota.max24HourSend} emails sent today)`,
    );
    return quota.maxSendRate;
  }

  // Fallback to safe default
  signale.warn(`[EMAIL-PROCESSOR] Failed to fetch AWS quota, using safe default: ${DEFAULT_RATE_LIMIT} emails/second`);
  return DEFAULT_RATE_LIMIT;
}

/**
 * Derive worker concurrency from the rate limit so a higher SES quota actually
 * translates into higher throughput. The mean job duration is ~0.5s (Prisma
 * reads + HTML compile + SES call + writes), so `rate * 0.5` gives ~2× headroom
 * over the per-second cap. Clamped to keep sandbox accounts useful and to
 * protect the Prisma pool on very large quotas.
 */
function deriveWorkerConcurrency(rateLimit: number): number {
  if (EMAIL_WORKER_CONCURRENCY !== undefined) {
    return EMAIL_WORKER_CONCURRENCY;
  }

  const TARGET_JOB_SECONDS = 0.5;
  const MIN_CONCURRENCY = 5;
  const derived = Math.ceil(rateLimit * TARGET_JOB_SECONDS);
  return Math.max(MIN_CONCURRENCY, Math.min(derived, EMAIL_WORKER_MAX_CONCURRENCY));
}

/**
 * How long to delay a job whose project has sending paused, before checking again.
 * On the order of a minute: long enough not to hammer the DB re-checking every job
 * retry, short enough that an unpause is honoured promptly. There is no cap on how
 * many times a job can be re-delayed -- a long pause legitimately holds mail for a
 * long time, and doing so does not consume a BullMQ retry attempt.
 */
const SENDING_PAUSE_HOLD_MS = 60_000;

/**
 * Processes a single queued email: the send path for every source (transactional,
 * campaign, workflow). Extracted from the Worker's processor callback so it can be
 * exercised directly in tests without a running BullMQ/Redis connection.
 */
export async function processEmailJob(job: Job<SendEmailJobData>, token?: string): Promise<void> {
  const {emailId} = job.data;

  const email = await prisma.email.findUnique({
    where: {id: emailId},
    include: {
      contact: true,
      project: true,
      template: {select: {type: true}},
      campaign: {select: {type: true}},
    },
  });

  if (!email) {
    throw new Error(`Email ${emailId} not found`);
  }

  if (email.status !== EmailStatus.PENDING) {
    return;
  }

  // Check if project is disabled
  if (email.project.disabled) {
    signale.warn(`[EMAIL-PROCESSOR] Project ${email.projectId} is disabled, cancelling email ${emailId}`);
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: 'Project is disabled',
      },
    });

    // Cancelled emails are terminal for the campaign — finalize so it doesn't
    // stay stuck in SENDING forever waiting on emails that will never be sent.
    if (email.campaignId) {
      await CampaignService.finalizeIfDone(email.campaignId);
    }
    return;
  }

  // Check if project sending is paused. Unlike `disabled`, this is NOT an
  // authentication-layer gate -- ingestion, workflows, and sequences all keep
  // running. It only stops the send, and it holds the mail rather than losing it:
  // the product decision is hold-and-resume, so a paused send leaves the email
  // PENDING and delays this job instead of writing a terminal status. Sequence and
  // workflow claims record the emailId at enqueue time, so a held job keeps its
  // claim, isn't reaped as stale, and isn't re-sent -- nothing needs to be replayed
  // once the project is unpaused. `sendingPaused` is re-read fresh here (rather
  // than trusting `email.project.sendingPaused`, snapshotted when this job started)
  // so a pause toggled mid-flight is honoured and an unpause lets held jobs through
  // promptly. See docs/issues/05-project-sending-pause.md.
  const freshProject = await prisma.project.findUnique({
    where: {id: email.projectId},
    select: {sendingPaused: true},
  });
  if (freshProject?.sendingPaused) {
    signale.info(`[EMAIL-PROCESSOR] Project ${email.projectId} sending is paused, holding email ${emailId}`);
    await job.moveToDelayed(Date.now() + SENDING_PAUSE_HOLD_MS, token);
    throw new DelayedError();
  }

  try {
    // Update status to sending
    await prisma.email.update({
      where: {id: emailId},
      data: {status: EmailStatus.SENDING},
    });

    // Format template variables in subject and body
    const contactData = (email.contact.data as Record<string, unknown>) || {};
    const formattedEmail = EmailService.format({
      subject: email.subject,
      body: email.body,
      data: {
        email: email.contact.email,
        ...contactData,
        data: contactData,
        unsubscribeUrl: withSourceEmail(`${DASHBOARD_URI}/unsubscribe/${email.contact.id}`, emailId),
        subscribeUrl: withSourceEmail(`${DASHBOARD_URI}/subscribe/${email.contact.id}`, emailId),
        manageUrl: withSourceEmail(`${DASHBOARD_URI}/manage/${email.contact.id}`, emailId),
      },
    });

    // Classify the email once: it decides both the unsubscribe footer and the
    // standards-based headers below, and (below, right before the SES call) which
    // mailable-contact predicate re-gates the send.
    const emailClass = classifyEmail({
      sourceType: email.sourceType,
      templateType: email.template?.type,
      campaignType: email.campaign?.type,
    });

    // Compile HTML with unsubscribe footer and badge.
    // Only marketing emails get the Plunk unsubscribe footer.
    const compiledHtml = EmailService.compile({
      content: formattedEmail.body,
      contact: email.contact,
      project: email.project,
      includeUnsubscribe: emailClass === 'marketing',
      sourceEmailId: emailId,
    });

    // Use fromName from database if available, otherwise fall back to project name
    // The 'from' field in the database is just the email address
    const fromName = email.fromName || email.project.name;
    const fromEmail = email.from;

    // Parse custom headers from JSON
    const customHeaders =
      email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers)
        ? (email.headers as Record<string, string>)
        : undefined;

    // Check for custom recipient override in headers. A contact with no email (a lead) can
    // only reach this point via such an override -- the send chokepoints (contact-filters.ts)
    // refuse to enroll/select a null-email contact otherwise -- so a miss here is a bug
    // upstream, not a case to paper over with a fallback address.
    const recipientOverride = customHeaders?.['X-Plunk-Recipient-Override'];

    // Remove internal headers before sending
    const publicHeaders = customHeaders ? {...customHeaders} : undefined;
    if (publicHeaders && 'X-Plunk-Recipient-Override' in publicHeaders) {
      delete publicHeaders['X-Plunk-Recipient-Override'];
    }

    // Build the outbound headers: standards-based defaults for the email class
    // plus any caller-supplied headers (which override the defaults).
    const outboundHeaders = buildEmailHeaders({
      emailClass,
      isCampaign: email.campaignId != null,
      hasListManagementLink: bodyHasListManagementLink(compiledHtml, email.contact.id),
      unsubscribeId: email.contact.id,
      sourceEmailId: emailId,
      customHeaders: publicHeaders,
    });

    // Determine tracking based on project settings and email type
    const shouldTrack = EmailService.shouldTrackEmail(email.project.tracking, email.sourceType);

    // Check for phishing/dangerous content before sending
    const phishingCheck = await SecurityService.checkPhishingContent(
      email.projectId,
      email.project.name,
      email.from,
      formattedEmail.subject,
      compiledHtml,
    );

    if (phishingCheck.shouldDisable) {
      // Disable project immediately
      await SecurityService.disableProjectForPhishing(
        email.projectId,
        formattedEmail.subject,
        phishingCheck.confidence,
        'Phishing content detected',
      );

      // Mark email as failed
      await prisma.email.update({
        where: {id: emailId},
        data: {
          status: EmailStatus.FAILED,
          error: 'This email could not be sent. The project has been disabled. Please contact support.',
        },
      });

      throw new Error(`Project ${email.projectId} has been disabled due to a policy violation`);
    }

    // Final contact-safety gate, immediately before the SES call. The `email.contact`
    // snapshot loaded at the top of this job can be stale by the time we get here: the
    // contact may have unsubscribed, been anonymized, or (transitively, via defect 2)
    // sat PENDING through a long pause. Re-read fresh and re-apply the same predicate
    // used at enrollment time -- marketing sends must stay subscribed, every send needs
    // a real, non-anonymized email address. This is a genuine stop: SUPPRESSED is
    // terminal, unlike the pause hold above, because someone who unsubscribed must not
    // be mailed later when whatever queued this job runs again.
    const freshContact = await prisma.contact.findUnique({
      where: {id: email.contactId},
      select: {email: true, subscribed: true, deletedAt: true},
    });
    // A recipient override supplies the address directly, which is the only way a lead
    // (null email) legitimately reaches this point -- see the override comment above. Let it
    // satisfy the email-present rule so the gate doesn't suppress that supported path, while
    // every other rule (subscribed for marketing, not-anonymized always) still applies to the
    // contact itself.
    const gatedContact = freshContact && recipientOverride ? {...freshContact, email: recipientOverride} : freshContact;
    const isMailable =
      emailClass === 'marketing' ? isMailableContact(gatedContact) : isTransactionallyMailableContact(gatedContact);

    if (!isMailable) {
      signale.warn(
        `[EMAIL-PROCESSOR] Contact ${email.contactId} is no longer mailable, suppressing email ${emailId}`,
      );
      await prisma.email.update({
        where: {id: emailId},
        data: {
          status: EmailStatus.SUPPRESSED,
          error: 'Contact is no longer mailable (unsubscribed, anonymized, or missing an email address)',
        },
      });

      if (email.campaignId) {
        await CampaignService.finalizeIfDone(email.campaignId);
      }
      return;
    }

    const recipientEmail = recipientOverride || freshContact?.email;
    if (!recipientEmail) {
      throw new Error(
        `Email ${emailId} has no recipient address: contact ${email.contactId} has no email and no recipient override header was set`,
      );
    }

    // Build recipient with name if available
    const recipient: {name?: string; email: string} | string = email.toName
      ? {name: email.toName, email: recipientEmail}
      : recipientEmail;

    // Send via AWS SES
    const result = await sendRawEmail({
      from: {
        name: fromName,
        email: fromEmail,
      },
      to: typeof recipient === 'string' ? [recipient] : [{name: recipient.name, email: recipient.email}],
      content: {
        subject: formattedEmail.subject,
        html: compiledHtml,
      },
      reply: email.replyTo || undefined,
      headers: outboundHeaders,
      tracking: shouldTrack,
      attachments: email.attachments as {filename: string; content: string; contentType: string}[] | null,
    });

    // Mark as sent with SES message ID.
    //
    // Guarded on `sentAt` still being null so the campaign counter below is only
    // incremented by the run that actually stamped it. A job retried after SES
    // accepted the message would otherwise count the same email twice.
    const marked = await prisma.email.updateMany({
      where: {id: emailId, sentAt: null},
      data: {
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId: result.messageId,
      },
    });

    // Zero rows means another run already stamped this email -- SES accepted the
    // message, then the job was retried. Everything below sends a second signal
    // for one delivery (a duplicate `email.sent` re-triggers workflows), so stop
    // here rather than replaying it. Finalization still runs: this email is
    // terminal either way, and the campaign must not be left stuck in SENDING.
    if (marked.count === 0) {
      signale.warn(`[EMAIL-PROCESSOR] Email ${emailId} was already marked sent, skipping duplicate side effects`);

      if (email.campaignId) {
        await CampaignService.finalizeIfDone(email.campaignId);
      }

      return;
    }

    if (email.campaignId) {
      await CampaignService.countCampaignSent(email.campaignId);
    }

    // Record usage for billing (pay-per-email)
    // Uses email ID as idempotency key to prevent double-charging on retries
    // Charge 2 emails if attachments are present
    if (email.project.customer) {
      const hasAttachments = email.attachments && Array.isArray(email.attachments) && email.attachments.length > 0;
      const emailCount = hasAttachments ? 2 : 1;
      await MeterService.recordEmailSent(email.project.customer, emailCount, `email_${emailId}`);
    }

    // Track event (this will trigger workflows)
    await EventService.trackEvent(email.projectId, 'email.sent', email.contactId, email.id, {
      subject: formattedEmail.subject,
      from: email.from,
      fromName: email.fromName,
      messageId: result.messageId,
      emailId: email.id,
      templateId: email.templateId,
      campaignId: email.campaignId,
      sourceType: email.sourceType,
      sentAt: new Date().toISOString(),
    });

    if (email.campaignId) {
      await CampaignService.finalizeIfDone(email.campaignId);
    }
  } catch (error) {
    signale.error(`[EMAIL-PROCESSOR] Failed to send email ${emailId}:`, error);

    // Mark as failed
    await prisma.email.update({
      where: {id: emailId},
      data: {
        status: EmailStatus.FAILED,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    throw error; // Re-throw to trigger retry
  }
}

export async function createEmailWorker() {
  // Fetch the rate limit (from env, AWS, or default)
  const rateLimit = await getEmailRateLimit();
  const concurrency = deriveWorkerConcurrency(rateLimit);
  signale.info(
    `[EMAIL-PROCESSOR] Worker concurrency: ${concurrency} (rate limit: ${rateLimit}/s)`,
  );
  const worker = new Worker<SendEmailJobData>(
    emailQueue.name,
    async (job: Job<SendEmailJobData>, token?: string) => processEmailJob(job, token),
    {
      connection: emailQueue.opts.connection,
      concurrency,
      limiter: {
        max: rateLimit, // Max emails per second (from env, AWS SES quota, or default)
        duration: 1000,
      },
    },
  );

  worker.on('completed', job => {
    signale.info(`[EMAIL-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[EMAIL-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[EMAIL-PROCESSOR] Worker error:', err);
  });

  return worker;
}
