import type {Sequence, SequenceStep} from '@plunk/db';
import {Prisma, SequenceStatus, TemplateType} from '@plunk/db';
import {compileTemplate} from '@plunk/shared';
import signale from 'signale';

import {DASHBOARD_URI} from '../app/constants.js';
import {
  isTransactionallyMailableContact,
  mailableContactWhere,
  transactionalMailableContactWhere,
} from '../database/contact-filters.js';
import {prisma} from '../database/prisma.js';
import {ConflictError, NotFound} from '../exceptions/index.js';

import {DomainService} from './DomainService.js';
import {EmailService} from './EmailService.js';

export interface SequenceEnrollOutcome {
  enrolled: number;
  skipped: number; // Already enrolled, or ineligible (lead / deleted contact) -- enrollMany only
}

export interface SequenceSweepOutcome {
  sent: number;
  failed: number;
  capped: boolean; // True when the per-run send cap cut the sweep short
}

/** Contacts fetched per page while sweeping a sequence's subscriptions. */
const SWEEP_BATCH_SIZE = 500;

/** Default hard ceiling of sends per sweep run; leftovers resume next run. */
const SWEEP_MAX_SENDS = 5000;

/** Claims older than this with no email attached are considered orphaned. */
const CLAIM_REAP_MINUTES = 30;

/**
 * Sequence Service
 *
 * Sequences are evolving ordered email series (ConvertKit-style): an ordered
 * list of steps that keeps growing, where every enrollee experiences the full
 * series from step one and caught-up contacts receive newly published steps on
 * the next sweep.
 *
 * Progress is the sent-set (`SequenceStepSend`), never a position pointer.
 * The sweep always sends the lowest-order published step missing from a
 * contact's sent-set, once the step's delay since that contact's previous send
 * (or enrollment) has elapsed. That makes editing and reordering steps safe at
 * any time: a moved already-sent step is simply excluded, and the unique
 * constraint on (sequenceStepId, contactId) makes double-sends structurally
 * impossible even under overlapping sweeps.
 */
export class SequenceService {
  // ============================================
  // CRUD
  // ============================================

  public static async list(projectId: string) {
    const sequences = await prisma.sequence.findMany({
      where: {projectId},
      include: {_count: {select: {subscriptions: true, steps: true}}},
      orderBy: {createdAt: 'desc'},
    });

    return sequences.map(({_count, ...sequence}) => ({
      ...sequence,
      subscriptionCount: _count.subscriptions,
      stepCount: _count.steps,
    }));
  }

  public static async get(projectId: string, sequenceId: string) {
    const sequence = await prisma.sequence.findFirst({
      where: {id: sequenceId, projectId},
      include: {
        steps: {orderBy: {order: 'asc'}},
        _count: {select: {subscriptions: true}},
      },
    });
    if (!sequence) {
      throw new NotFound('sequence');
    }

    const {_count, ...rest} = sequence;
    return {...rest, subscriptionCount: _count.subscriptions, stepCount: sequence.steps.length};
  }

  public static async create(
    projectId: string,
    data: {
      name: string;
      type?: TemplateType;
      from?: string | null;
      fromName?: string | null;
      replyTo?: string | null;
      enrollTagId?: string | null;
    },
  ): Promise<Sequence> {
    if (data.enrollTagId) {
      await this.assertTagInProject(projectId, data.enrollTagId);
    }

    return prisma.sequence.create({
      data: {
        projectId,
        name: data.name.trim(),
        type: data.type ?? TemplateType.MARKETING,
        from: data.from ?? null,
        fromName: data.fromName ?? null,
        replyTo: data.replyTo ?? null,
        enrollTagId: data.enrollTagId ?? null,
      },
    });
  }

  public static async update(
    projectId: string,
    sequenceId: string,
    data: {
      name?: string;
      status?: SequenceStatus;
      type?: TemplateType;
      from?: string | null;
      fromName?: string | null;
      replyTo?: string | null;
      enrollTagId?: string | null;
    },
  ): Promise<Sequence> {
    const sequence = await this.getRaw(projectId, sequenceId);

    if (data.enrollTagId) {
      await this.assertTagInProject(projectId, data.enrollTagId);
    }

    // Activation requires a deliverable sender: sends would otherwise fail on
    // every sweep. Same domain check campaigns run before sending.
    if (data.status === SequenceStatus.ACTIVE && sequence.status !== SequenceStatus.ACTIVE) {
      const from = data.from !== undefined ? data.from : sequence.from;
      if (!from) {
        throw new ConflictError('A verified sender address is required before activating a sequence');
      }
      await DomainService.verifyEmailDomain(from, projectId);
    }

    return prisma.sequence.update({
      where: {id: sequence.id},
      data: {
        name: data.name?.trim(),
        status: data.status,
        type: data.type,
        from: data.from,
        fromName: data.fromName,
        replyTo: data.replyTo,
        enrollTagId: data.enrollTagId,
      },
    });
  }

  public static async delete(projectId: string, sequenceId: string): Promise<void> {
    const sequence = await this.getRaw(projectId, sequenceId);
    await prisma.sequence.delete({where: {id: sequence.id}});
  }

  // ============================================
  // STEPS
  // ============================================

  public static async createStep(
    projectId: string,
    sequenceId: string,
    data: {subject: string; body: string; delayMinutes: number},
  ): Promise<SequenceStep> {
    const sequence = await this.getRaw(projectId, sequenceId);

    const last = await prisma.sequenceStep.aggregate({
      where: {sequenceId: sequence.id},
      _max: {order: true},
    });

    return prisma.sequenceStep.create({
      data: {
        sequenceId: sequence.id,
        order: (last._max.order ?? 0) + 1,
        subject: data.subject,
        body: data.body,
        delayMinutes: data.delayMinutes,
      },
    });
  }

  public static async updateStep(
    projectId: string,
    sequenceId: string,
    stepId: string,
    data: {subject?: string; body?: string; delayMinutes?: number},
  ): Promise<SequenceStep> {
    const step = await this.getStep(projectId, sequenceId, stepId);

    return prisma.sequenceStep.update({
      where: {id: step.id},
      data: {
        subject: data.subject,
        body: data.body,
        delayMinutes: data.delayMinutes,
      },
    });
  }

  /**
   * Publishing is explicit and one-way: a published step is immediately
   * eligible for sending to every caught-up contact on the next sweep.
   */
  public static async publishStep(projectId: string, sequenceId: string, stepId: string): Promise<SequenceStep> {
    const step = await this.getStep(projectId, sequenceId, stepId);

    return prisma.sequenceStep.update({
      where: {id: step.id},
      data: {published: true},
    });
  }

  public static async deleteStep(projectId: string, sequenceId: string, stepId: string): Promise<void> {
    const step = await this.getStep(projectId, sequenceId, stepId);
    await prisma.sequenceStep.delete({where: {id: step.id}});
  }

  /**
   * Apply a full new ordering. `stepIds` must contain every step of the
   * sequence exactly once. Orders are rewritten 1..n in one transaction; the
   * order column is deliberately not unique so no temporary offsets are needed.
   */
  public static async reorderSteps(projectId: string, sequenceId: string, stepIds: string[]): Promise<void> {
    const sequence = await this.getRaw(projectId, sequenceId);

    const steps = await prisma.sequenceStep.findMany({
      where: {sequenceId: sequence.id},
      select: {id: true},
    });

    const currentIds = new Set(steps.map(step => step.id));
    const incomingIds = new Set(stepIds);
    if (currentIds.size !== stepIds.length || incomingIds.size !== stepIds.length || stepIds.some(id => !currentIds.has(id))) {
      throw new ConflictError('Reorder must include every step of the sequence exactly once');
    }

    await prisma.$transaction(
      stepIds.map((id, index) =>
        prisma.sequenceStep.update({
          where: {id},
          data: {order: index + 1},
        }),
      ),
    );
  }

  // ============================================
  // ENROLLMENT
  // ============================================

  /**
   * Enroll a single contact. Idempotent: enrolling an already-enrolled contact
   * is a silent no-op. DRAFT sequences reject enrollment; PAUSED accepts it
   * (the contact simply waits until the sequence resumes).
   */
  public static async enroll(projectId: string, sequenceId: string, contactId: string): Promise<SequenceEnrollOutcome> {
    const sequence = await this.getRaw(projectId, sequenceId);

    if (sequence.status === SequenceStatus.DRAFT) {
      throw new ConflictError('Draft sequences do not accept enrollments');
    }

    const contact = await prisma.contact.findFirst({
      where: {id: contactId, projectId},
      select: {id: true, email: true, subscribed: true, deletedAt: true},
    });
    if (!contact) {
      throw new NotFound('contact');
    }
    // A lead (no email) or a deleted contact can never be sent to, so enrolling one would just
    // create a subscription row the sweep silently filters forever. Reject up front instead.
    if (!isTransactionallyMailableContact(contact)) {
      throw new ConflictError('Contact has no email on file and cannot be enrolled in a sequence');
    }

    try {
      await prisma.sequenceSubscription.create({
        data: {sequenceId: sequence.id, contactId},
      });
      return {enrolled: 1, skipped: 0};
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return {enrolled: 0, skipped: 1};
      }
      throw error;
    }
  }

  /**
   * Enroll many contacts at once (already resolved to ids and validated as
   * belonging to the project by the caller). Idempotent via skipDuplicates.
   *
   * Leads (no email) and deleted contacts are excluded with a single batched query rather than
   * per-id -- same reasoning as `enroll`, just filtered instead of thrown, since this path is
   * meant for background bulk enrollment where one ineligible id shouldn't fail the whole batch.
   * They're folded into `skipped` alongside already-enrolled duplicates.
   */
  public static async enrollMany(projectId: string, sequenceId: string, contactIds: string[]): Promise<SequenceEnrollOutcome> {
    const sequence = await this.getRaw(projectId, sequenceId);

    if (sequence.status === SequenceStatus.DRAFT) {
      throw new ConflictError('Draft sequences do not accept enrollments');
    }

    if (contactIds.length === 0) {
      return {enrolled: 0, skipped: 0};
    }

    const mailable = await prisma.contact.findMany({
      where: {id: {in: contactIds}, projectId, ...transactionalMailableContactWhere()},
      select: {id: true},
    });
    const mailableIds = mailable.map(contact => contact.id);

    if (mailableIds.length === 0) {
      return {enrolled: 0, skipped: contactIds.length};
    }

    const result = await prisma.sequenceSubscription.createMany({
      data: mailableIds.map(contactId => ({sequenceId: sequence.id, contactId})),
      skipDuplicates: true,
    });

    return {enrolled: result.count, skipped: contactIds.length - result.count};
  }

  /**
   * Remove a contact from a sequence. Their sent-set rows are wiped in the
   * same transaction: re-enrollment always restarts at step one, so stale send
   * records would only cause the restarted pass to skip steps.
   */
  public static async unenroll(projectId: string, sequenceId: string, contactId: string): Promise<void> {
    const sequence = await this.getRaw(projectId, sequenceId);

    const subscription = await prisma.sequenceSubscription.findUnique({
      where: {sequenceId_contactId: {sequenceId: sequence.id, contactId}},
    });
    if (!subscription) {
      throw new NotFound('subscription');
    }

    await prisma.$transaction([
      prisma.sequenceSubscription.delete({where: {id: subscription.id}}),
      prisma.sequenceStepSend.deleteMany({where: {sequenceId: sequence.id, contactId}}),
    ]);
  }

  // ============================================
  // STATS
  // ============================================

  /**
   * Aggregate stats computed on demand from Email rows. v1 keeps no
   * materialized counters; the (sequenceId) index on emails makes these
   * six indexed counts cheap at any realistic sequence size.
   */
  public static async getStats(projectId: string, sequenceId: string) {
    const sequence = await this.getRaw(projectId, sequenceId);

    const [sent, delivered, opened, clicked, bounced, complained] = await prisma.$transaction([
      prisma.email.count({where: {sequenceId: sequence.id, sentAt: {not: null}}}),
      prisma.email.count({where: {sequenceId: sequence.id, deliveredAt: {not: null}}}),
      prisma.email.count({where: {sequenceId: sequence.id, openedAt: {not: null}}}),
      prisma.email.count({where: {sequenceId: sequence.id, clickedAt: {not: null}}}),
      prisma.email.count({where: {sequenceId: sequence.id, bouncedAt: {not: null}}}),
      prisma.email.count({where: {sequenceId: sequence.id, complainedAt: {not: null}}}),
    ]);

    return {sent, delivered, opened, clicked, bounced, complained};
  }

  // ============================================
  // SWEEP
  // ============================================

  /**
   * One delivery pass over every ACTIVE sequence. Called by the repeatable
   * sequence-sweep job every 5 minutes.
   */
  public static async sweepAllDue(maxSends: number = SWEEP_MAX_SENDS): Promise<SequenceSweepOutcome> {
    await this.reapStaleClaims();

    const sequences = await prisma.sequence.findMany({
      where: {status: SequenceStatus.ACTIVE},
      include: {steps: {where: {published: true}, orderBy: {order: 'asc'}}},
    });

    const outcome: SequenceSweepOutcome = {sent: 0, failed: 0, capped: false};

    for (const sequence of sequences) {
      if (outcome.capped) break;
      const remaining = maxSends - outcome.sent;
      const result = await this.sweepSequence(sequence, remaining);
      outcome.sent += result.sent;
      outcome.failed += result.failed;
      outcome.capped = result.capped;
    }

    if (outcome.capped) {
      signale.warn(`[SEQUENCE] Sweep hit the ${maxSends}-send cap; remaining sends resume next run`);
    }

    return outcome;
  }

  /**
   * Sweep a single sequence: keyset-paginate its subscriptions, compute each
   * contact's next due step from their sent-set, and claim-then-send.
   *
   * Query budget: 2 queries per batch of SWEEP_BATCH_SIZE contacts (the
   * subscription page and one sent-set fetch for the whole batch) — never the
   * full contact set in memory, no per-contact queries outside actual sends.
   */
  public static async sweepSequence(
    sequence: Sequence & {steps: SequenceStep[]},
    maxSends: number = SWEEP_MAX_SENDS,
  ): Promise<SequenceSweepOutcome> {
    const outcome: SequenceSweepOutcome = {sent: 0, failed: 0, capped: false};

    if (sequence.steps.length === 0 || !sequence.from) {
      return outcome;
    }

    const now = Date.now();
    let cursor: string | undefined;

    // Liquid templates are compiled once per step per run, lazily on first use.
    const compiled = new Map<string, {subject: ReturnType<typeof compileTemplate>; body: ReturnType<typeof compileTemplate>}>();

    while (true) {
      const subscriptions = await prisma.sequenceSubscription.findMany({
        where: {
          sequenceId: sequence.id,
          contact: mailableContactWhere(),
        },
        include: {contact: {select: {id: true, email: true, data: true}}},
        orderBy: {contactId: 'asc'},
        take: SWEEP_BATCH_SIZE,
        ...(cursor
          ? {cursor: {sequenceId_contactId: {sequenceId: sequence.id, contactId: cursor}}, skip: 1}
          : {}),
      });

      if (subscriptions.length === 0) break;
      cursor = subscriptions[subscriptions.length - 1]?.contactId;

      const sends = await prisma.sequenceStepSend.findMany({
        where: {sequenceId: sequence.id, contactId: {in: subscriptions.map(s => s.contactId)}},
        select: {contactId: true, sequenceStepId: true, sentAt: true},
      });

      const sentByContact = new Map<string, {stepIds: Set<string>; lastSentAt: number}>();
      for (const send of sends) {
        let entry = sentByContact.get(send.contactId);
        if (!entry) {
          entry = {stepIds: new Set(), lastSentAt: 0};
          sentByContact.set(send.contactId, entry);
        }
        entry.stepIds.add(send.sequenceStepId);
        if (send.sentAt) {
          entry.lastSentAt = Math.max(entry.lastSentAt, send.sentAt.getTime());
        }
      }

      for (const subscription of subscriptions) {
        if (outcome.sent >= maxSends) {
          outcome.capped = true;
          return outcome;
        }

        const progress = sentByContact.get(subscription.contactId);
        const next = sequence.steps.find(step => !progress?.stepIds.has(step.id));
        if (!next) continue; // Caught up

        // A pending claim (row without sentAt) also lands in stepIds and
        // correctly blocks re-selection of that step here.
        const anchor = progress?.lastSentAt || subscription.enrolledAt.getTime();
        if (now - anchor < next.delayMinutes * 60_000) continue;

        // `mailableContactWhere()` above already filters out null-email contacts, so this is
        // provably unreachable -- but the type system can't see across the query boundary.
        // Guard defensively (skip this contact, keep sweeping the rest) rather than assert.
        if (!subscription.contact.email) {
          signale.warn(
            `[SEQUENCE] Skipping contact ${subscription.contact.id} with no email in sequence ${sequence.id}`,
          );
          continue;
        }

        const contact = {...subscription.contact, email: subscription.contact.email};
        const result = await this.claimAndSend(sequence, next, contact, compiled);
        if (result === 'sent') outcome.sent += 1;
        if (result === 'failed') outcome.failed += 1;
      }

      if (subscriptions.length < SWEEP_BATCH_SIZE) break;
    }

    return outcome;
  }

  /**
   * Claim-then-send for one contact and step.
   *
   * The claim insert races on the (sequenceStepId, contactId) unique
   * constraint: a P2002 means another sweep (or a past send) owns this step
   * for this contact, and we skip silently — that constraint is the structural
   * double-send backstop. A failed send releases its claim so the next sweep
   * retries; a crash between claim and send is covered by reapStaleClaims.
   */
  private static async claimAndSend(
    sequence: Sequence,
    step: SequenceStep,
    contact: {id: string; email: string; data: unknown},
    compiled: Map<string, {subject: ReturnType<typeof compileTemplate>; body: ReturnType<typeof compileTemplate>}>,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    let claimId: string;
    try {
      const claim = await prisma.sequenceStepSend.create({
        data: {sequenceId: sequence.id, sequenceStepId: step.id, contactId: contact.id},
        select: {id: true},
      });
      claimId = claim.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'skipped';
      }
      throw error;
    }

    try {
      let templates = compiled.get(step.id);
      if (!templates) {
        templates = {subject: compileTemplate(step.subject), body: compileTemplate(step.body)};
        compiled.set(step.id, templates);
      }

      const contactData =
        contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data) ? contact.data : {};
      const variables = {
        id: contact.id,
        email: contact.email,
        ...contactData,
        data: contactData,
        unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/${contact.id}`,
        subscribeUrl: `${DASHBOARD_URI}/subscribe/${contact.id}`,
        manageUrl: `${DASHBOARD_URI}/manage/${contact.id}`,
      };

      const email = await EmailService.sendCampaignEmail({
        projectId: sequence.projectId,
        contactId: contact.id,
        subject: templates.subject.render(variables),
        body: templates.body.render(variables),
        from: sequence.from as string,
        fromName: sequence.fromName || undefined,
        replyTo: sequence.replyTo || undefined,
        sequenceId: sequence.id,
        sequenceStepId: step.id,
        isTransactional: sequence.type === TemplateType.TRANSACTIONAL,
      });

      await prisma.sequenceStepSend.update({
        where: {id: claimId},
        data: {emailId: email.id, sentAt: new Date()},
      });

      return 'sent';
    } catch (error) {
      signale.warn(`[SEQUENCE] Send failed for contact ${contact.id}, step ${step.id}; releasing claim:`, error);
      await prisma.sequenceStepSend.delete({where: {id: claimId}}).catch(() => undefined);
      return 'failed';
    }
  }

  /**
   * Delete claims that never completed (emailId still null well past any
   * plausible send duration) so a crash between claim and send retries
   * instead of silently skipping that step for that contact forever.
   */
  public static async reapStaleClaims(): Promise<number> {
    const result = await prisma.sequenceStepSend.deleteMany({
      where: {
        emailId: null,
        createdAt: {lt: new Date(Date.now() - CLAIM_REAP_MINUTES * 60_000)},
      },
    });

    if (result.count > 0) {
      signale.warn(`[SEQUENCE] Reaped ${result.count} stale send claim(s)`);
    }

    return result.count;
  }

  // ============================================
  // INTERNAL
  // ============================================

  private static async getRaw(projectId: string, sequenceId: string): Promise<Sequence> {
    const sequence = await prisma.sequence.findFirst({where: {id: sequenceId, projectId}});
    if (!sequence) {
      throw new NotFound('sequence');
    }
    return sequence;
  }

  private static async getStep(projectId: string, sequenceId: string, stepId: string): Promise<SequenceStep> {
    const step = await prisma.sequenceStep.findFirst({
      where: {id: stepId, sequenceId, sequence: {projectId}},
    });
    if (!step) {
      throw new NotFound('step');
    }
    return step;
  }

  private static async assertTagInProject(projectId: string, tagId: string): Promise<void> {
    const tag = await prisma.tag.findFirst({where: {id: tagId, projectId}, select: {id: true}});
    if (!tag) {
      throw new NotFound('tag');
    }
  }
}
