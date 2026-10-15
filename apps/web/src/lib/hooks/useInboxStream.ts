import {openEventStream} from '@plunk/shared/event-stream';
import type {InboxStreamEvent} from '@plunk/types';
import {useEffect, useRef, useState} from 'react';

import {API_URI} from '../constants';

/**
 * Subscribes to the active project's inbox events while `enabled`. Returns whether the stream is
 * connected, so callers can fall back to polling when it is not.
 */
export function useInboxStream(
  projectId: string | undefined,
  enabled: boolean,
  onEvent: (event: InboxStreamEvent) => void,
): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });

  useEffect(() => {
    if (!projectId || !enabled) {
      return;
    }
    const stream = openEventStream({
      url: `${API_URI}/conversations/stream`,
      credentials: 'include',
      headers: () => ({'X-Project-Id': projectId}),
      onEvent: data => handler.current(JSON.parse(data) as InboxStreamEvent),
      onOpen: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });
    const reconnect = () => stream.reconnect();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnect();
      }
    };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisible);
      stream.close();
      setConnected(false);
    };
  }, [projectId, enabled]);

  return connected;
}
