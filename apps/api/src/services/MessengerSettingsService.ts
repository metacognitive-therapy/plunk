import type {MessengerSettings} from '@plunk/db';
import {MESSENGER_DEFAULT_ACCENT} from '@plunk/shared';
import type {MessengerAppearance, MessengerSettingsData} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {redis, wrapRedis} from '../database/redis.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

import {Keys} from './keys.js';

const SETTINGS_CACHE_SECONDS = 60;

const DEFAULT_SETTINGS: MessengerSettingsData = {
  enabled: false,
  allowedOrigins: [],
  accentColor: MESSENGER_DEFAULT_ACCENT,
  launcherPosition: 'RIGHT',
  greeting: null,
  teamUserIds: [],
};

export class MessengerSettingsService {
  public static async get(projectId: string): Promise<MessengerSettingsData> {
    const cached = await wrapRedis<MessengerSettingsData | {missing: true}>(
      Keys.Messenger.settings(projectId),
      async () => {
        const row = await prisma.messengerSettings.findUnique({where: {projectId}});
        return row ? this.toData(row) : {missing: true};
      },
      SETTINGS_CACHE_SECONDS,
    );
    if ('missing' in cached) {
      return DEFAULT_SETTINGS;
    }
    return cached;
  }

  public static async update(projectId: string, patch: Partial<MessengerSettingsData>): Promise<MessengerSettingsData> {
    if (patch.teamUserIds) {
      patch.teamUserIds = [...new Set(patch.teamUserIds)];
      const agents = await this.supportAgentIds(projectId, patch.teamUserIds);
      if (agents.size !== patch.teamUserIds.length) {
        throw new HttpException(400, 'Team avatars must be support agents of this project', ErrorCode.VALIDATION_ERROR);
      }
    }

    const row = await prisma.messengerSettings.upsert({
      where: {projectId},
      create: {projectId, ...patch},
      update: patch,
    });
    await redis.del(Keys.Messenger.settings(projectId), Keys.Messenger.appearance(projectId));
    return this.toData(row);
  }

  /**
   * What the messenger needs to draw itself. Team members are re-checked against the current
   * support agents, so someone who lost inbox access drops out without the settings being edited.
   */
  public static async appearance(projectId: string, settings: MessengerSettingsData): Promise<MessengerAppearance> {
    const team = await wrapRedis<MessengerAppearance['team']>(
      Keys.Messenger.appearance(projectId),
      async () => {
        if (settings.teamUserIds.length === 0) {
          return [];
        }
        const memberships = await prisma.membership.findMany({
          where: {
            projectId,
            userId: {in: settings.teamUserIds},
            OR: [{role: 'OWNER'}, {supportAgent: true}],
          },
          select: {user: {select: {id: true, name: true}}},
        });
        const names = new Map(memberships.map(m => [m.user.id, m.user.name?.trim() || null]));
        return settings.teamUserIds.flatMap(id => {
          const name = names.get(id);
          return name ? [{id, name}] : [];
        });
      },
      SETTINGS_CACHE_SECONDS,
    );

    return {
      accentColor: settings.accentColor,
      launcherPosition: settings.launcherPosition,
      greeting: settings.greeting,
      team,
    };
  }

  public static isOriginAllowed(settings: MessengerSettingsData, origin: string): boolean {
    return settings.allowedOrigins.includes(origin);
  }

  private static async supportAgentIds(projectId: string, userIds: string[]): Promise<Set<string>> {
    const memberships = await prisma.membership.findMany({
      where: {projectId, userId: {in: userIds}, OR: [{role: 'OWNER'}, {supportAgent: true}]},
      select: {userId: true},
    });
    return new Set(memberships.map(m => m.userId));
  }

  private static toData(row: MessengerSettings): MessengerSettingsData {
    return {
      enabled: row.enabled,
      allowedOrigins: row.allowedOrigins,
      accentColor: row.accentColor,
      launcherPosition: row.launcherPosition,
      greeting: row.greeting,
      teamUserIds: row.teamUserIds,
    };
  }
}
