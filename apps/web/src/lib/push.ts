import type {NotificationSchemas} from '@plunk/shared';

import {network} from './network';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register('/sw.js', {scope: '/'});
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') {
    return 'denied';
  }
  return Notification.permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
}

function decodeKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) {
    return false;
  }
  const view = new Uint8Array(a);
  return view.every((byte, index) => byte === b[index]);
}

async function save(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  await network.fetch<void, typeof NotificationSchemas.subscribe>('POST', '/users/@me/push-subscriptions', {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: {p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? ''},
  });
}

/** Asks for permission and subscribes this browser. Throws with a message the agent can act on. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }
  if (!(await registerServiceWorker())) {
    throw new Error('This browser could not start background notifications.');
  }
  const registration = await navigator.serviceWorker.ready;
  const key = decodeKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  /* A subscription made for an earlier server key can never receive our pushes. */
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  await save(subscription);
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) {
    return;
  }
  await network
    .fetch<void, typeof NotificationSchemas.unsubscribe>('DELETE', '/users/@me/push-subscriptions', {
      endpoint: subscription.endpoint,
    })
    .catch(() => undefined);
  await subscription.unsubscribe();
}

/* The browser may rotate a subscription, and a device keeps its subscription across sign-ins, so
the signed-in agent re-claims it on every load. */
export async function resyncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') {
    return;
  }
  const subscription = await currentSubscription();
  if (subscription) {
    await save(subscription).catch(() => undefined);
  }
}
