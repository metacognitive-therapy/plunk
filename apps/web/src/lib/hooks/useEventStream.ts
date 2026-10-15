import {openEventStream} from '@plunk/shared/event-stream';
import {useEffect, useRef, useState} from 'react';

import {API_URI} from '../constants';

/**
 * Holds an API event stream open while `key` is set, reconnecting when the tab comes back or the
 * network returns. `key` also names what the stream is for: a change reopens it. Returns whether
 * the stream is connected, so callers can fall back to polling when it is not.
 */
export function useEventStream<T>(
  path: string,
  key: string | null,
  headers: () => Record<string, string>,
  onEvent: (event: T) => void,
): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  const headersRef = useRef(headers);
  useEffect(() => {
    handler.current = onEvent;
    headersRef.current = headers;
  });

  useEffect(() => {
    if (!key) {
      return;
    }
    const stream = openEventStream({
      url: `${API_URI}${path}`,
      credentials: 'include',
      headers: () => headersRef.current(),
      onEvent: data => handler.current(JSON.parse(data) as T),
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
  }, [path, key]);

  return connected;
}
