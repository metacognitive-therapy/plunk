import {SequenceStatus} from '@plunk/db';

import {prisma} from '../database/prisma.js';

/**
 * Sequence auto-enrollment
 *
 * Deliberately tiny and dependency-free (no EventService / TagService /
 * SequenceService imports) so EventService can call it from its tag-event
 * fan-out without creating an import cycle
 * (TagService → EventService → Sequence*).
 *
 * Auto-enroll fires only while a sequence is ACTIVE — a DRAFT or PAUSED
 * sequence bound to the tag ignores the event. Enrollment is idempotent
 * (skipDuplicates) and removing the tag later never unenrolls: tags and
 * sequence membership are decoupled once enrollment has happened.
 */
export class SequenceEnrollmentService {
  public static async handleTagAdded(projectId: string, contactId: string, tagId: string): Promise<void> {
    const sequences = await prisma.sequence.findMany({
      where: {projectId, status: SequenceStatus.ACTIVE, enrollTagId: tagId},
      select: {id: true},
    });

    if (sequences.length === 0) {
      return;
    }

    await prisma.sequenceSubscription.createMany({
      data: sequences.map(sequence => ({sequenceId: sequence.id, contactId})),
      skipDuplicates: true,
    });
  }
}
