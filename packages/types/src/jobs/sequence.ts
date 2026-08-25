/**
 * Sequence queue job data types
 */

import type {BulkContactActionSelector} from './import.js';

/**
 * Job data for the sequence delivery sweep
 * Used by: sequenceSweepQueue worker
 *
 * Empty: each run processes every ACTIVE sequence's due contacts.
 */
export interface SequenceSweepJobData {
  /** Optional override for how many emails one run may send. */
  maxSends?: number;
}

/**
 * Job data for bulk sequence enrollment across many contacts.
 * Used by: bulkSequenceQueue worker
 */
export interface BulkSequenceEnrollJobData {
  projectId: string;
  sequenceId: string;
  selector: BulkContactActionSelector;
}
