import {randomUUID} from 'node:crypto';

import type {Redis} from 'ioredis';
import signale from 'signale';

import {redis} from '../database/redis.js';

type Listener = (frame: string) => void;

/**
 * Fans Redis pub/sub out to the event streams held by this process. A process opens one subscriber
 * connection however many streams it serves, and each channel is subscribed while at least one
 * stream listens to it.
 */
export class RealtimeHub {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subscribing = new Map<string, Promise<unknown>>();
  private readonly resetListeners = new Set<() => void>();
  public readonly connectionName = `plunk-realtime-${randomUUID()}`;

  public constructor(private readonly connect: (connectionName: string) => Redis = name => redis.duplicate({connectionName: name})) {}

  /** Resolves once Redis has confirmed the subscription, so nothing published afterwards is missed. */
  public async subscribe(channel: string, listener: Listener): Promise<() => Promise<void>> {
    const connection = this.connection();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);

    if (set.size === 1) {
      const pending = connection.subscribe(channel).finally(() => this.subscribing.delete(channel));
      this.subscribing.set(channel, pending);
      await pending;
    } else {
      await this.subscribing.get(channel);
    }

    let active = true;
    return async () => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(channel);
        await connection.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /** Called when the subscriber reconnected to Redis: anything published during the gap was missed. */
  public onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  /** Publishing never fails the caller: the database stays the source of truth and clients resync. */
  public static async publish(channel: string, event: object): Promise<void> {
    try {
      await redis.publish(channel, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}\n${JSON.stringify(event)}`);
    } catch (error) {
      signale.warn('[REALTIME] Publish failed:', error);
    }
  }

  public async close(): Promise<void> {
    this.listeners.clear();
    this.resetListeners.clear();
    const subscriber = this.subscriber;
    this.subscriber = null;
    await subscriber?.quit().catch(() => undefined);
  }

  private connection(): Redis {
    if (!this.subscriber) {
      const subscriber = this.connect(this.connectionName);
      subscriber.on('message', (channel: string, frame: string) => {
        this.listeners.get(channel)?.forEach(listener => listener(frame));
      });
      subscriber.on('error', error => signale.warn('[REALTIME] Subscriber error:', error));
      let readyBefore = false;
      subscriber.on('ready', () => {
        if (readyBefore) {
          this.resetListeners.forEach(listener => listener());
        }
        readyBefore = true;
      });
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }
}

export const realtime = new RealtimeHub();
