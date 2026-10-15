import {randomBytes} from 'node:crypto';

import type {MessengerSettings, Prisma} from '@plunk/db';
import {
  MESSENGER_DEFAULT_ACCENT,
  MESSENGER_DEFAULT_TIMEZONE,
  MESSENGER_EMAIL_DELAY_DEFAULT_MINUTES,
  MESSENGER_RETENTION_DEFAULT_MONTHS,
} from '@plunk/shared';
import type {MessengerAppearance, MessengerAvailability, MessengerSettingsData, OfficeHoursDay} from '@plunk/types';

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
  replyDomain: null,
  replyFromEmail: null,
  emailDelayMinutes: MESSENGER_EMAIL_DELAY_DEFAULT_MINUTES,
  slackConnected: false,
  replyTime: 'FEW_HOURS',
  officeHoursEnabled: false,
  officeHours: [],
  timezone: MESSENGER_DEFAULT_TIMEZONE,
  retentionMonths: MESSENGER_RETENTION_DEFAULT_MONTHS,
  identityVerification: false,
  userAttributes: [],
};

export type MessengerSettingsPatch = Partial<Omit<MessengerSettingsData, 'slackConnected' | 'identityVerification'>> & {
  slackWebhookUrl?: string | null;
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

  public static async update(projectId: string, patch: MessengerSettingsPatch): Promise<MessengerSettingsData> {
    if (patch.teamUserIds) {
      patch.teamUserIds = [...new Set(patch.teamUserIds)];
      const agents = await this.supportAgentIds(projectId, patch.teamUserIds);
      if (agents.size !== patch.teamUserIds.length) {
        throw new HttpException(400, 'Team avatars must be support agents of this project', ErrorCode.VALIDATION_ERROR);
      }
    }
    if (patch.replyDomain || patch.replyFromEmail) {
      await this.assertEmailAddresses(projectId, patch);
    }
    if (patch.officeHoursEnabled || patch.officeHours) {
      await this.assertOfficeHours(projectId, patch);
    }

    const {officeHours, ...rest} = patch;
    const data = {
      ...rest,
      ...(officeHours ? {officeHours: officeHours as unknown as Prisma.InputJsonValue} : {}),
    };
    const row = await prisma.messengerSettings.upsert({
      where: {projectId},
      create: {projectId, ...data},
      update: data,
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

  /** What the messenger needs to say whether the team is around. Judged on the visitor's side, so it stays current. */
  public static availability(settings: MessengerSettingsData): MessengerAvailability {
    return {
      replyTime: settings.replyTime,
      officeHours: settings.officeHoursEnabled ? {timezone: settings.timezone, days: settings.officeHours} : null,
    };
  }

  /** The saved webhook URL. Read uncached and only where a post is about to be made. */
  public static async slackWebhookUrl(projectId: string): Promise<string | null> {
    const row = await prisma.messengerSettings.findUnique({where: {projectId}, select: {slackWebhookUrl: true}});
    return row?.slackWebhookUrl ?? null;
  }

  /** The secret user tokens are signed with. Read uncached, so a rotation takes effect at once. */
  public static async identitySecret(projectId: string): Promise<string | null> {
    const row = await prisma.messengerSettings.findUnique({where: {projectId}, select: {identitySecret: true}});
    return row?.identitySecret ?? null;
  }

  /** Replaces the secret, which invalidates every user token signed with the old one. */
  public static async rotateIdentitySecret(projectId: string): Promise<string> {
    const identitySecret = randomBytes(32).toString('hex');
    await prisma.messengerSettings.upsert({
      where: {projectId},
      create: {projectId, identitySecret},
      update: {identitySecret},
    });
    await redis.del(Keys.Messenger.settings(projectId));
    return identitySecret;
  }

  public static isOriginAllowed(settings: MessengerSettingsData, origin: string): boolean {
    return settings.allowedOrigins.includes(origin);
  }

  /** Whether agent replies can be emailed: both addresses are set. */
  public static emailEnabled(
    settings: MessengerSettingsData,
  ): settings is MessengerSettingsData & {replyDomain: string; replyFromEmail: string} {
    return Boolean(settings.replyDomain && settings.replyFromEmail);
  }

  /* The reply domain must be a subdomain, never the verified domain itself: its MX record would
  otherwise take over the organisation's normal inbox. */
  private static async assertEmailAddresses(
    projectId: string,
    patch: Pick<Partial<MessengerSettingsData>, 'replyDomain' | 'replyFromEmail'>,
  ): Promise<void> {
    const verified = await prisma.domain.findMany({where: {projectId, verified: true}, select: {domain: true}});
    const domains = verified.map(row => row.domain.toLowerCase());
    if (patch.replyDomain && !domains.some(domain => patch.replyDomain!.endsWith(`.${domain}`))) {
      throw new HttpException(
        400,
        'The reply domain must be a subdomain of one of this project’s verified domains, such as reply.example.com',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (patch.replyFromEmail && !domains.includes(patch.replyFromEmail.split('@')[1]!)) {
      throw new HttpException(
        400,
        'Replies must be sent from an address on one of this project’s verified domains',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  /* With office hours on and no day open, the messenger would say the team is away forever. */
  private static async assertOfficeHours(
    projectId: string,
    patch: Pick<Partial<MessengerSettingsData>, 'officeHoursEnabled' | 'officeHours'>,
  ): Promise<void> {
    const current = patch.officeHoursEnabled === undefined || patch.officeHours === undefined ? await this.get(projectId) : null;
    const enabled = patch.officeHoursEnabled ?? current!.officeHoursEnabled;
    const days = patch.officeHours ?? current!.officeHours;
    if (enabled && days.length === 0) {
      throw new HttpException(400, 'Open at least one day, or turn office hours off', ErrorCode.VALIDATION_ERROR);
    }
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
      replyDomain: row.replyDomain,
      replyFromEmail: row.replyFromEmail,
      emailDelayMinutes: row.emailDelayMinutes,
      slackConnected: Boolean(row.slackWebhookUrl),
      replyTime: row.replyTime,
      officeHoursEnabled: row.officeHoursEnabled,
      officeHours: Array.isArray(row.officeHours)
        ? (row.officeHours as unknown as OfficeHoursDay[]).map(({day, start, end}) => ({day, start, end}))
        : [],
      timezone: row.timezone,
      retentionMonths: row.retentionMonths,
      identityVerification: Boolean(row.identitySecret),
      userAttributes: row.userAttributes,
    };
  }
}
