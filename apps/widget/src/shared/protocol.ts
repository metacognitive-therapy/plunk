import type {MessengerAppearance} from '@plunk/types';

export const PROTOCOL = 'plunk-chat';

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type FrameMessage =
  | {source: typeof PROTOCOL; type: 'ready'}
  | {source: typeof PROTOCOL; type: 'booted'; appearance: MessengerAppearance}
  | {source: typeof PROTOCOL; type: 'failed'}
  | {source: typeof PROTOCOL; type: 'unread'; count: number}
  | {source: typeof PROTOCOL; type: 'close'};

export type HostMessage =
  | {source: typeof PROTOCOL; type: 'init'; visitorId: string}
  | {source: typeof PROTOCOL; type: 'opened'}
  | {source: typeof PROTOCOL; type: 'update'};

export function isProtocolMessage(data: unknown): data is {source: typeof PROTOCOL; type: string} {
  return typeof data === 'object' && data !== null && (data as {source?: unknown}).source === PROTOCOL;
}

export function generateVisitorId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** White or near-black, whichever reads better on the accent colour (WCAG relative luminance). */
export function contrastColor(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#111827' : '#ffffff';
}
