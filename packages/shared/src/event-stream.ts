/*
 * A Server-Sent Events client built on fetch, so requests can carry an Authorization or project
 * header (EventSource cannot) and tokens never end up in URLs or access logs. It imports nothing,
 * because the messenger bundles it and must stay small.
 */

export interface EventStreamOptions {
  url: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  credentials?: 'include' | 'omit' | 'same-origin';
  onEvent: (data: string) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  /** Called on a 401 before the next attempt, typically to refresh the token the headers use. */
  onUnauthorized?: () => Promise<void> | void;
  /** Called once when the server refuses the stream for good (403 or 404); no retry follows. */
  onRefused?: (status: number) => void;
  /** Reconnects when nothing, not even a heartbeat, arrives for this long. */
  idleTimeoutMs?: number;
  maxBackoffMs?: number;
}

export interface EventStream {
  close(): void;
  /** Drops the current connection or pending retry and connects again straight away. */
  reconnect(): void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export function openEventStream(options: EventStreamOptions): EventStream {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const backoff = () => {
    const base = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
    attempt += 1;
    return base / 2 + Math.random() * (base / 2);
  };

  const connectOnce = async (): Promise<'retry' | 'stop'> => {
    controller = new AbortController();
    const signal = controller.signal;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller?.abort(), idleTimeoutMs);
    };

    let opened = false;
    try {
      resetIdle();
      const response = await fetch(options.url, {
        headers: {Accept: 'text/event-stream', ...(await options.headers?.())},
        credentials: options.credentials,
        cache: 'no-store',
        signal,
      });

      if (response.status === 401) {
        await options.onUnauthorized?.();
        return 'retry';
      }
      if (response.status === 403 || response.status === 404) {
        options.onRefused?.(response.status);
        return 'stop';
      }
      if (!response.ok || !response.body) {
        return 'retry';
      }

      opened = true;
      attempt = 0;
      options.onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        resetIdle();
        buffer += decoder.decode(value, {stream: true});
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const data = block
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) {
            options.onEvent(data);
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
      return 'retry';
    } catch {
      return 'retry';
    } finally {
      clearTimeout(idle);
      controller = null;
      if (opened) {
        options.onDisconnect?.();
      }
    }
  };

  void (async () => {
    while (!closed) {
      const outcome = await connectOnce();
      if (outcome === 'stop' || closed) {
        return;
      }
      await sleep(backoff());
    }
  })();

  return {
    close() {
      closed = true;
      controller?.abort();
      wake?.();
    },
    reconnect() {
      attempt = 0;
      controller?.abort();
      wake?.();
    },
  };
}
