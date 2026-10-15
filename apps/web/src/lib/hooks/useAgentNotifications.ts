import type {AgentNotificationPrefs, InboxUnread} from '@plunk/types';
import useSWR from 'swr';

export const INBOX_UNREAD_KEY = '/users/@me/inbox-unread';
export const NOTIFICATION_PREFS_KEY = '/users/@me/notifications';

/* The stream refreshes the count as visitors write; the interval only catches what the stream does
not carry, such as a colleague closing or taking a conversation. */
const UNREAD_REFRESH_MS = 60_000;

export function useInboxUnread(enabled: boolean) {
  return useSWR<{success: boolean; data: InboxUnread}>(enabled ? INBOX_UNREAD_KEY : null, {
    refreshInterval: UNREAD_REFRESH_MS,
    shouldRetryOnError: false,
  });
}

export function useNotificationPrefs(enabled = true) {
  return useSWR<{success: boolean; data: AgentNotificationPrefs}>(enabled ? NOTIFICATION_PREFS_KEY : null, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}

/** "3", or "99+" past what a badge can show. */
export function formatUnread(unread: InboxUnread | undefined): string | null {
  if (!unread || unread.total === 0) {
    return null;
  }
  return unread.total > 99 ? '99+' : String(unread.total);
}
