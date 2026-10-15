import type {Request, Response} from 'express';

import {type RealtimeHub, realtime} from '../services/RealtimeHub.js';

export interface EventStreamOptions {
  heartbeatMs?: number;
  /* Auth and access are checked when a stream opens, so streams are recycled: a revoked agent or a
  disabled messenger loses the stream at the latest on the next reconnect. */
  maxLifetimeMs?: number;
  hub?: RealtimeHub;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_MAX_LIFETIME_MS = 10 * 60_000;

/**
 * Holds the response open as a Server-Sent Events stream of everything published on the channels.
 * The first event, ready, is sent only once the channels are subscribed; clients refetch on it, so
 * anything that happened before the stream (or while it was down) is caught up through the REST API.
 */
export async function serveEventStream(
  req: Request,
  res: Response,
  channels: string[],
  options: EventStreamOptions & {expiresAt?: Date} = {},
): Promise<void> {
  const hub = options.hub ?? realtime;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const untilExpiry = options.expiresAt ? options.expiresAt.getTime() - Date.now() : Number.POSITIVE_INFINITY;
  const lifetimeMs = Math.max(0, Math.min(options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS, untilExpiry));

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  let closed = false;
  const write = (chunk: string) => {
    if (!closed) {
      res.write(chunk);
    }
  };

  const onFrame = (frame: string) => {
    const split = frame.indexOf('\n');
    write(`id: ${frame.slice(0, split)}\ndata: ${frame.slice(split + 1)}\n\n`);
  };

  let unsubscribes: (() => Promise<void>)[] = [];
  const handles: {
    heartbeat?: ReturnType<typeof setInterval>;
    lifetime?: ReturnType<typeof setTimeout>;
    offReset?: () => void;
  } = {};

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(handles.heartbeat);
    clearTimeout(handles.lifetime);
    handles.offReset?.();
    for (const unsubscribe of unsubscribes) {
      void unsubscribe();
    }
  };
  res.on('close', cleanup);

  try {
    unsubscribes = await Promise.all(channels.map(channel => hub.subscribe(channel, onFrame)));
  } catch {
    cleanup();
    res.end();
    return;
  }
  if (closed) {
    for (const unsubscribe of unsubscribes) {
      void unsubscribe();
    }
    return;
  }

  handles.offReset = hub.onReset(() => {
    cleanup();
    res.end();
  });
  write(`data: ${JSON.stringify({type: 'ready'})}\n\n`);
  handles.heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
  handles.lifetime = setTimeout(() => {
    cleanup();
    res.end();
  }, lifetimeMs);
}
