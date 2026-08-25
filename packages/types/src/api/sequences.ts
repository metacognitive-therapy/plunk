/**
 * Sequence service types
 */

import type {SequenceStatus, TemplateType} from '@plunk/db';

export interface SequenceStepResponse {
  id: string;
  order: number;
  subject: string;
  body: string;
  delayMinutes: number;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SequenceResponse {
  id: string;
  name: string;
  status: SequenceStatus;
  type: TemplateType;
  from: string | null;
  fromName: string | null;
  replyTo: string | null;
  enrollTagId: string | null;
  subscriptionCount: number;
  stepCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SequenceWithStepsResponse extends SequenceResponse {
  steps: SequenceStepResponse[];
}

export interface SequenceStatsResponse {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

export interface SequenceEnrollResult {
  enrolled: number;
  skipped: number; // Already enrolled
}
