import type {MessengerSettings} from '@plunk/db';
import type {MessengerSettingsData} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {redis, wrapRedis} from '../database/redis.js';

import {Keys} from './keys.js';

const SETTINGS_CACHE_SECONDS = 60;

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
      return {enabled: false, allowedOrigins: []};
    }
    return cached;
  }

  public static async update(projectId: string, patch: Partial<MessengerSettingsData>): Promise<MessengerSettingsData> {
    const row = await prisma.messengerSettings.upsert({
      where: {projectId},
      create: {projectId, ...patch},
      update: patch,
    });
    await redis.del(Keys.Messenger.settings(projectId));
    return this.toData(row);
  }

  public static isOriginAllowed(settings: MessengerSettingsData, origin: string): boolean {
    return settings.allowedOrigins.includes(origin);
  }

  private static toData(row: MessengerSettings): MessengerSettingsData {
    return {enabled: row.enabled, allowedOrigins: row.allowedOrigins};
  }
}
