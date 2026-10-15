import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {MembershipSchemas, MessengerSettingsSchemas, UtilitySchemas} from '@plunk/shared';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {MembershipService} from '../services/MembershipService.js';
import {MessengerSettingsService} from '../services/MessengerSettingsService.js';
import {SlackService} from '../services/SlackService.js';
import {SecurityService} from '../services/SecurityService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('projects')
export class Projects {
  /**
   * Get project setup state for dashboard quick start
   * GET /projects/:id/setup-state
   */
  @Get(':id/setup-state')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async getSetupState(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    // Verify user has access to this project
    await MembershipService.requireAccess(auth.userId!, id);

    // Get project with relevant data
    const project = await prisma.project.findUnique({
      where: {id},
      select: {
        subscription: true,
        _count: {
          select: {
            contacts: true,
            domains: {
              where: {verified: true},
            },
            workflows: {
              where: {enabled: true},
            },
          },
        },
      },
    });

    if (!project) {
      throw new HttpException(404, 'Project not found');
    }

    // Get last sent campaign
    const lastCampaign = await prisma.campaign.findFirst({
      where: {
        projectId: id,
        status: 'SENT',
        sentAt: {not: null},
      },
      orderBy: {
        sentAt: 'desc',
      },
      select: {
        sentAt: true,
      },
    });

    return res.json({
      success: true,
      data: {
        hasSubscription: !!project.subscription,
        hasVerifiedDomain: project._count.domains > 0,
        contactCount: project._count.contacts,
        lastCampaignSentAt: lastCampaign?.sentAt || null,
        hasEnabledWorkflow: project._count.workflows > 0,
      },
    });
  }

  /**
   * Get project security metrics
   * GET /projects/:id/security
   */
  @Get(':id/security')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async getSecurityMetrics(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    // Verify user has access to this project
    await MembershipService.requireAccess(auth.userId!, id);

    // Use existing SecurityService
    const metrics = await SecurityService.getProjectSecurityMetrics(id);

    return res.json({
      success: true,
      data: metrics,
    });
  }

  /**
   * Get all members of a project
   * GET /projects/:id/members
   */
  @Get(':id/members')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async getMembers(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    // Verify user has access to this project
    await MembershipService.requireAccess(auth.userId!, id);

    // Get all members of the project
    const members = await MembershipService.getMembers(id);

    return res.json({
      success: true,
      data: members,
    });
  }

  /**
   * Add a member to a project by email
   * POST /projects/:id/members
   * Body: { email: string, role?: 'ADMIN' | 'MEMBER' }
   */
  @Post(':id/members')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async addMember(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    // Validate params
    if (!id) {
      throw new HttpException(400, 'Project ID is required');
    }

    // Validate and parse request body
    const parseResult = MembershipSchemas.addMember.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpException(400, parseResult.error.errors[0]?.message || 'Invalid request body');
    }

    const {email, role} = parseResult.data;

    // Verify current user is ADMIN or OWNER
    await MembershipService.requireAdminAccess(auth.userId!, id);

    // Find user by email
    const userToAdd = await prisma.user.findUnique({
      where: {email: email.toLowerCase()},
      select: {id: true, email: true},
    });

    if (!userToAdd) {
      throw new HttpException(404, 'User with this email does not have an account');
    }

    // Add member to project
    const newMembership = await MembershipService.addMember(id, userToAdd.id, role);

    return res.json({
      success: true,
      data: {
        userId: userToAdd.id,
        email: userToAdd.email,
        role: newMembership.role,
      },
    });
  }

  /**
   * Update a member's role
   * PATCH /projects/:id/members/:userId
   * Body: { role: 'ADMIN' | 'MEMBER' }
   */
  @Patch(':id/members/:userId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async updateMemberRole(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id, userId} = req.params;

    // Validate params
    if (!id) {
      throw new HttpException(400, 'Project ID is required');
    }
    if (!userId) {
      throw new HttpException(400, 'User ID is required');
    }

    // Validate and parse request body
    const parseResult = MembershipSchemas.updateRole.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpException(400, parseResult.error.errors[0]?.message || 'Invalid request body');
    }

    const {role} = parseResult.data;

    // Verify current user is ADMIN or OWNER
    await MembershipService.requireAdminAccess(auth.userId!, id);

    // Get user info
    const user = await prisma.user.findUnique({
      where: {id: userId},
      select: {id: true, email: true},
    });

    if (!user) {
      throw new HttpException(404, 'User not found');
    }

    // Update role (service handles validation)
    await MembershipService.updateRole(id, userId, role);

    return res.json({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        role,
      },
    });
  }

  /**
   * Remove a member from a project
   * DELETE /projects/:id/members/:userId
   */
  @Delete(':id/members/:userId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async removeMember(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id, userId} = req.params;

    // Validate params
    if (!id) {
      throw new HttpException(400, 'Project ID is required');
    }
    if (!userId) {
      throw new HttpException(400, 'User ID is required');
    }

    // Verify current user is ADMIN or OWNER
    await MembershipService.requireAdminAccess(auth.userId!, id);

    // Cannot remove yourself
    if (userId === auth.userId) {
      throw new HttpException(403, 'You cannot remove yourself from the project');
    }

    // Remove member (service handles validation)
    await MembershipService.removeMember(id, userId);

    return res.json({
      success: true,
      data: {message: 'Member removed successfully'},
    });
  }

  /**
   * Toggle whether a member can work the support inbox. Owners always can, whatever the flag says.
   * PATCH /projects/:id/members/:userId/support-agent
   */
  @Patch(':id/members/:userId/support-agent')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async setSupportAgent(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse({id: req.params.id});
    const {id: userId} = UtilitySchemas.id.parse({id: req.params.userId});
    const {supportAgent} = MembershipSchemas.setSupportAgent.parse(req.body);

    await MembershipService.requireAdminAccess(auth.userId!, id);
    const membership = await MembershipService.setSupportAgent(id, userId, supportAgent);

    return res.json({success: true, data: {userId, supportAgent: membership.supportAgent}});
  }

  /**
   * GET /projects/:id/messenger
   */
  @Get(':id/messenger')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async getMessengerSettings(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAccess(auth.userId!, id);
    const data = await MessengerSettingsService.get(id);

    return res.json({success: true, data});
  }

  /**
   * PATCH /projects/:id/messenger
   */
  @Patch(':id/messenger')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async updateMessengerSettings(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const patch = MessengerSettingsSchemas.update.parse(req.body);

    await MembershipService.requireAdminAccess(auth.userId!, id);
    const data = await MessengerSettingsService.update(id, {
      ...patch,
      allowedOrigins: patch.allowedOrigins ? [...new Set(patch.allowedOrigins)] : undefined,
    });

    return res.json({success: true, data});
  }

  /**
   * POST /projects/:id/messenger/slack/test
   */
  @Post(':id/messenger/slack/test')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  private async testSlackWebhook(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const {url} = MessengerSettingsSchemas.slackTest.parse(req.body ?? {});

    await MembershipService.requireAdminAccess(auth.userId!, id);
    await SlackService.test(id, url);

    return res.json({success: true});
  }
}
