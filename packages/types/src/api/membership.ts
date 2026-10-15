/**
 * Project membership types
 */

import type {Role} from '@plunk/db';

/**
 * Project member with user email
 */
export interface MemberWithEmail {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  supportAgent: boolean;
  createdAt: Date;
}

/**
 * Project owner information
 */
export interface OwnerInfo {
  userId: string;
  email: string;
}

/**
 * Information about disabled projects for a user
 */
export interface DisabledProjectInfo {
  hasDisabledProject: boolean;
  disabledProjectNames: string[];
}
