import type {AgentNotificationPrefs, ChatPushPayload} from '@plunk/types';
import signale from 'signale';
import webpush from 'web-push';

import {VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT, WEB_PUSH_ENABLED} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException} from '../exceptions/index.js';

/* A chat notification that waited this long in a push service is no longer worth showing. */
const PUSH_TTL_SECONDS = 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

/* The server posts to whatever endpoint a browser hands it, so only the browsers' own push
services are accepted. Anything else would let a signed-in user make the API call internal URLs. */
const PUSH_SERVICE_HOSTS = ['.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {p256dh: string; auth: string};
}

export class WebPushService {
  public static publicKey(): string | null {
    return WEB_PUSH_ENABLED ? VAPID_PUBLIC_KEY : null;
  }

  /** Saves this browser for the user. A browser that was subscribed by someone else moves over. */
  public static async subscribe(userId: string, input: PushSubscriptionInput, userAgent?: string): Promise<void> {
    if (!WEB_PUSH_ENABLED) {
      throw new HttpException(404, 'Push notifications are not set up on this server', ErrorCode.RESOURCE_NOT_FOUND);
    }
    const host = new URL(input.endpoint).hostname;
    if (!PUSH_SERVICE_HOSTS.some(suffix => host.endsWith(suffix))) {
      throw new HttpException(400, 'This browser’s push service is not supported', ErrorCode.VALIDATION_ERROR);
    }
    const data = {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: userAgent?.slice(0, 255) ?? null,
    };
    await prisma.webPushSubscription.upsert({
      where: {endpoint: input.endpoint},
      create: {endpoint: input.endpoint, ...data},
      update: data,
    });
  }

  public static async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await prisma.webPushSubscription.deleteMany({where: {userId, endpoint}});
  }

  /**
   * Pushes to every browser of the given users. Subscriptions the push service reports as gone
   * are deleted. Never throws: a push failure must not fail the job that notifies in-app.
   */
  public static async send(
    userIds: string[],
    payload: (prefs: Pick<AgentNotificationPrefs, 'pushPreview'>) => ChatPushPayload,
  ): Promise<{sent: number; pruned: number}> {
    if (!WEB_PUSH_ENABLED || userIds.length === 0) {
      return {sent: 0, pruned: 0};
    }
    const subscriptions = await prisma.webPushSubscription.findMany({
      where: {userId: {in: userIds}},
      include: {user: {select: {pushPreview: true}}},
    });

    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      subscriptions.map(async subscription => {
        try {
          await webpush.sendNotification(
            {endpoint: subscription.endpoint, keys: {p256dh: subscription.p256dh, auth: subscription.auth}},
            JSON.stringify(payload(subscription.user)),
            {
              vapidDetails: {subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY},
              TTL: PUSH_TTL_SECONDS,
              urgency: 'high',
              timeout: PUSH_TIMEOUT_MS,
            },
          );
          sent++;
        } catch (error) {
          const status = error instanceof webpush.WebPushError ? error.statusCode : null;
          if (status === 404 || status === 410) {
            gone.push(subscription.id);
          } else {
            signale.warn(`[WEB-PUSH] Push to subscription ${subscription.id} failed:`, status ?? error);
          }
        }
      }),
    );

    if (gone.length > 0) {
      await prisma.webPushSubscription.deleteMany({where: {id: {in: gone}}});
    }
    return {sent, pruned: gone.length};
  }
}
