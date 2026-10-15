import type {Membership} from '@plunk/db';
import type {DisabledProjectInfo, MemberWithEmail, OwnerInfo} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {redis, REDIS_ONE_MINUTE, wrapRedis} from '../database/redis.js';
import {HttpException} from '../exceptions/index.js';
import {Keys} from './keys.js';

const FIVE_MINUTES_IN_SECONDS = 5 * 60;

/**
 * Service for managing project memberships
 * Centralizes all membership-related database queries with caching
 */
export class MembershipService {
  /** Owners always qualify, so a project can never lock itself out of its own conversations. */
  public static isSupportAgent(membership: Pick<Membership, 'role' | 'supportAgent'>): boolean {
    return membership.role === 'OWNER' || membership.supportAgent;
  }

  // ============================================
  // AUTHORIZATION METHODS (Cached)
  // ============================================

  /**
   * Check if user has any access to a project (any role)
   * CACHED (1 min TTL) - called on every authenticated request
   */
  public static async hasAccess(userId: string, projectId: string): Promise<boolean> {
    return wrapRedis(
      Keys.Membership.access(userId, projectId),
      async () => {
        const membership = await prisma.membership.findUnique({
          where: {
            userId_projectId: {
              userId,
              projectId,
            },
          },
        });
        return membership !== null;
      },
      REDIS_ONE_MINUTE,
    );
  }

  /**
   * Check if user has admin or owner access to a project
   * CACHED (1 min TTL) - called before write operations
   */
  public static async hasAdminAccess(userId: string, projectId: string): Promise<boolean> {
    return wrapRedis(
      Keys.Membership.admin(userId, projectId),
      async () => {
        const membership = await prisma.membership.findFirst({
          where: {
            userId,
            projectId,
            role: {
              in: ['ADMIN', 'OWNER'],
            },
          },
        });
        return membership !== null;
      },
      REDIS_ONE_MINUTE,
    );
  }

  /**
   * Get user's membership with role info
   * CACHED (1 min TTL) - returns full membership or null
   */
  public static async getMembership(userId: string, projectId: string): Promise<Membership | null> {
    return wrapRedis(
      Keys.Membership.full(userId, projectId),
      async () => {
        return prisma.membership.findUnique({
          where: {
            userId_projectId: {
              userId,
              projectId,
            },
          },
        });
      },
      REDIS_ONE_MINUTE,
    );
  }

  /**
   * Require membership or throw 404
   * Uses cached getMembership internally
   */
  public static async requireAccess(userId: string, projectId: string): Promise<Membership> {
    const membership = await this.getMembership(userId, projectId);

    if (!membership) {
      throw new HttpException(404, 'Project not found or you do not have access');
    }

    return membership;
  }

  /**
   * Require admin/owner access or throw 403
   * Uses cached hasAdminAccess internally
   */
  public static async requireAdminAccess(userId: string, projectId: string): Promise<Membership> {
    const membership = await this.getMembership(userId, projectId);

    if (!membership) {
      throw new HttpException(404, 'Project not found or you do not have access');
    }

    if (membership.role !== 'ADMIN' && membership.role !== 'OWNER') {
      throw new HttpException(403, 'Insufficient permissions. Admin or owner access required.');
    }

    return membership;
  }

  // ============================================
  // MEMBER LISTING (Not Cached - Dynamic Data)
  // ============================================

  /**
   * Get all members of a project with user info
   * NOT CACHED - returns fresh data for member management UI
   */
  public static async getMembers(projectId: string): Promise<MemberWithEmail[]> {
    const memberships = await prisma.membership.findMany({
      where: {
        projectId,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return memberships.map(m => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      supportAgent: m.supportAgent,
      createdAt: m.createdAt,
    }));
  }

  /**
   * Get project owner
   * CACHED (5 min TTL) - owner rarely changes
   */
  public static async getOwner(projectId: string): Promise<OwnerInfo> {
    return wrapRedis(
      Keys.Membership.owner(projectId),
      async () => {
        const ownerMembership = await prisma.membership.findFirst({
          where: {
            projectId,
            role: 'OWNER',
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        });

        if (!ownerMembership) {
          throw new HttpException(404, 'Project owner not found');
        }

        return {
          userId: ownerMembership.userId,
          email: ownerMembership.user.email,
        };
      },
      FIVE_MINUTES_IN_SECONDS,
    );
  }

  // ============================================
  // CRUD OPERATIONS (Invalidate Cache)
  // ============================================

  /**
   * Add a member to a project
   * Invalidates cache for the project
   */
  public static async addMember(projectId: string, userId: string, role: 'ADMIN' | 'MEMBER'): Promise<Membership> {
    // Check if membership already exists
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });

    if (existingMembership) {
      throw new HttpException(409, 'User is already a member of this project');
    }

    // Create new membership
    const newMembership = await prisma.membership.create({
      data: {
        userId,
        projectId,
        role,
      },
    });

    // Invalidate cache
    await this.invalidateCache(projectId, userId);

    return newMembership;
  }

  /**
   * Update a member's role
   * Throws if trying to change OWNER role
   * Invalidates cache
   */
  public static async updateRole(projectId: string, userId: string, newRole: 'ADMIN' | 'MEMBER'): Promise<Membership> {
    // Get existing membership
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });

    if (!existingMembership) {
      throw new HttpException(404, 'Membership not found');
    }

    // Prevent changing OWNER role
    if (existingMembership.role === 'OWNER') {
      throw new HttpException(403, 'Cannot change the role of the project owner');
    }

    // Update role
    const updatedMembership = await prisma.membership.update({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
      data: {
        role: newRole,
      },
    });

    // Invalidate cache
    await this.invalidateCache(projectId, userId);

    return updatedMembership;
  }

  public static async setSupportAgent(projectId: string, userId: string, supportAgent: boolean): Promise<Membership> {
    const existingMembership = await prisma.membership.findUnique({
      where: {userId_projectId: {userId, projectId}},
    });

    if (!existingMembership) {
      throw new HttpException(404, 'Membership not found');
    }

    const updatedMembership = await prisma.membership.update({
      where: {userId_projectId: {userId, projectId}},
      data: {supportAgent},
    });
    if (!this.isSupportAgent(updatedMembership)) {
      await this.releaseAssignments(projectId, userId);
    }

    await this.invalidateCache(projectId, userId);

    return updatedMembership;
  }

  /**
   * Remove a member from a project
   * Throws if trying to remove OWNER
   * Invalidates cache
   */
  public static async removeMember(projectId: string, userId: string): Promise<void> {
    // Get existing membership
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });

    if (!existingMembership) {
      throw new HttpException(404, 'Membership not found');
    }

    // Prevent removing OWNER
    if (existingMembership.role === 'OWNER') {
      throw new HttpException(403, 'Cannot remove the project owner');
    }

    // Delete membership
    await prisma.membership.delete({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });
    await this.releaseAssignments(projectId, userId);

    // Invalidate cache
    await this.invalidateCache(projectId, userId);
  }

  /* Only support agents can be assignees, so someone who stops being one hands their
  conversations back to the Unassigned view. */
  private static async releaseAssignments(projectId: string, userId: string): Promise<void> {
    await prisma.conversation.updateMany({where: {projectId, assigneeId: userId}, data: {assigneeId: null}});
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Check if user is member of any disabled project
   * NOT CACHED - security-critical check
   */
  public static async userHasDisabledProject(userId: string): Promise<DisabledProjectInfo> {
    const disabledMemberships = await prisma.membership.findMany({
      where: {
        userId,
        project: {
          disabled: true,
        },
      },
      include: {
        project: {
          select: {
            name: true,
          },
        },
      },
    });

    return {
      hasDisabledProject: disabledMemberships.length > 0,
      disabledProjectNames: disabledMemberships.map(m => m.project.name),
    };
  }

  // ============================================
  // PRIVATE CACHE MANAGEMENT
  // ============================================

  /**
   * Invalidate all caches for a project and user
   * Called after membership changes
   */
  private static async invalidateCache(projectId: string, userId?: string): Promise<void> {
    const keysToDelete: string[] = [];

    if (userId) {
      // Invalidate user-specific caches
      keysToDelete.push(
        Keys.Membership.access(userId, projectId),
        Keys.Membership.admin(userId, projectId),
        Keys.Membership.full(userId, projectId),
      );
    }

    // Invalidate project-wide caches
    keysToDelete.push(Keys.Membership.owner(projectId), Keys.Messenger.appearance(projectId));

    // Delete all keys
    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }
  }
}
