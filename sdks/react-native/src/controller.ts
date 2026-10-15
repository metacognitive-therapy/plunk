import type {EventStream, EventStreamTransport} from '@plunk/shared/event-stream';

import {MessengerApiError, MessengerClient} from './client';
import type {BootResponse, ConversationSummary, KeyValueStorage, PlunkConfig, StreamEvent, UserLogin} from './types';

export type Route = {screen: 'home'} | {screen: 'thread'; conversationId: string | null; draft?: string};

export interface MessengerState {
  /** `none` before any login and after logout. */
  session: 'none' | 'anonymous' | 'verified';
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
  boot: BootResponse | null;
  /** Server clock minus device clock, so office hours are judged by the server's time. */
  clockSkew: number;
  conversations: ConversationSummary[];
  visible: boolean;
  route: Route;
  connected: boolean;
}

type Listener = () => void;
type StreamListener = (event: StreamEvent) => void;

const INITIAL: MessengerState = {
  session: 'none',
  status: 'idle',
  error: null,
  boot: null,
  clockSkew: 0,
  conversations: [],
  visible: false,
  route: {screen: 'home'},
  connected: false,
};

const VISITOR_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function generateVisitorId(): string {
  const bytes = new Uint8Array(32);
  const crypto = (globalThis as {crypto?: {getRandomValues?: (array: Uint8Array) => Uint8Array}}).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => VISITOR_ALPHABET[byte % VISITOR_ALPHABET.length]).join('');
}

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async key => {
      values.delete(key);
    },
  };
}

/**
 * One messenger for the app: who is signed in, their conversations and unread count, and whether
 * the messenger is showing. The stream stays open while someone is signed in and the app is in the
 * foreground, so the unread count moves even while the messenger is closed.
 */
export class MessengerController {
  private state: MessengerState = INITIAL;
  private readonly listeners = new Set<Listener>();
  private readonly streamListeners = new Set<StreamListener>();
  private readonly unreadListeners = new Set<(count: number) => void>();
  private readonly storage: KeyValueStorage;
  private client: MessengerClient | null = null;
  private stream: EventStream | null = null;
  private login: UserLogin | null = null;
  private generation = 0;
  private active = true;
  private lastUnread = 0;

  public constructor(
    public readonly config: PlunkConfig,
    private readonly transport?: EventStreamTransport,
  ) {
    this.storage = config.storage ?? memoryStorage();
  }

  public getState(): MessengerState {
    return this.state;
  }

  public getClient(): MessengerClient | null {
    return this.client;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onStreamEvent(listener: StreamListener): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  public addUnreadCountListener(listener: (count: number) => void): () => void {
    this.unreadListeners.add(listener);
    return () => this.unreadListeners.delete(listener);
  }

  public getUnreadConversationCount(): number {
    return this.state.conversations.filter(conversation => conversation.unread).length;
  }

  public loginUser(login: UserLogin): Promise<void> {
    this.login = login;
    return this.start('verified');
  }

  public loginUnidentifiedUser(): Promise<void> {
    this.login = null;
    return this.start('anonymous');
  }

  /** Ends the session and forgets the visitor, so whoever signs in next starts with nothing. */
  public async logout(): Promise<void> {
    this.stop();
    this.login = null;
    await this.storage.setItem(this.visitorKey(), generateVisitorId());
    this.set({...INITIAL});
  }

  public retry(): Promise<void> {
    return this.login ? this.loginUser(this.login) : this.loginUnidentifiedUser();
  }

  public present(): void {
    this.show({screen: 'home'});
  }

  public presentMessageComposer(initialMessage?: string): void {
    this.show({screen: 'thread', conversationId: null, draft: initialMessage});
  }

  public presentConversation(conversationId: string): void {
    this.show({screen: 'thread', conversationId});
  }

  public hide(): void {
    this.set({visible: false});
  }

  public navigate(route: Route): void {
    this.set({route});
  }

  /** Called by the provider as the app moves between foreground and background. */
  public setAppActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (!active) {
      this.stream?.close();
      this.stream = null;
      this.set({connected: false});
    } else if (this.client) {
      this.openStream();
      void this.refreshConversations();
    }
  }

  public async refreshConversations(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client) {
      return;
    }
    const conversations = await client.listConversations().catch(() => null);
    if (conversations && generation === this.generation) {
      this.set({conversations});
    }
  }

  /** Records that the user has seen a conversation, here and on the server. */
  public async markRead(conversationId: string): Promise<void> {
    this.patchConversation(conversationId, {unread: false});
    await this.client?.markRead(conversationId).catch(() => undefined);
  }

  public upsertConversation(summary: ConversationSummary): void {
    const others = this.state.conversations.filter(conversation => conversation.id !== summary.id);
    this.set({conversations: [summary, ...others]});
  }

  private show(route: Route): void {
    if (this.state.session === 'none') {
      this.loginUnidentifiedUser().catch(() => undefined);
    }
    this.set({visible: true, route});
  }

  private async start(session: 'anonymous' | 'verified'): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    this.set({session, status: 'loading', error: null, boot: null, conversations: [], connected: false});

    const visitorId = await this.visitorId();
    const login = this.login;
    const client = new MessengerClient({
      apiUrl: this.config.apiUrl,
      publicKey: this.config.publicKey,
      visitorId,
      getUserToken: login ? () => login.getUserToken() : undefined,
      transport: this.transport,
    });

    try {
      const boot = await client.boot();
      const conversations = await client.listConversations();
      if (generation !== this.generation) {
        return;
      }
      this.client = client;
      this.set({status: 'ready', boot, conversations, clockSkew: Date.parse(boot.serverTime) - Date.now()});
      if (this.active) {
        this.openStream();
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const message = error instanceof MessengerApiError ? error.message : 'The messenger could not start';
      this.set({status: 'failed', error: message});
      throw error;
    }
  }

  private stop(): void {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.client = null;
  }

  private openStream(): void {
    const client = this.client;
    if (!client) {
      return;
    }
    this.stream?.close();
    this.stream = client.openStream({
      onOpen: () => {
        this.set({connected: true});
        /* Anything sent while the stream was down only shows up in a fresh list. */
        void this.refreshConversations();
      },
      onDisconnect: () => this.set({connected: false}),
      onEvent: data => {
        let event: StreamEvent;
        try {
          event = JSON.parse(data) as StreamEvent;
        } catch {
          return;
        }
        this.handle(event);
      },
    });
  }

  private handle(event: StreamEvent): void {
    if (event.type === 'message') {
      const existing = this.state.conversations.find(conversation => conversation.id === event.conversationId);
      if (!existing) {
        void this.refreshConversations();
      } else {
        const fromTeam = event.message.authorType === 'AGENT';
        this.patchConversation(event.conversationId, {
          lastMessageAt: event.message.createdAt,
          lastMessage: {body: event.message.body, authorType: event.message.authorType},
          unread: fromTeam ? !this.isViewing(event.conversationId) : existing.unread,
        });
        const updated = this.state.conversations.find(conversation => conversation.id === event.conversationId)!;
        this.upsertConversation(updated);
      }
    } else if (event.type === 'conversation') {
      this.patchConversation(event.conversationId, {status: event.status});
    }
    for (const listener of this.streamListeners) {
      listener(event);
    }
  }

  private isViewing(conversationId: string): boolean {
    const {visible, route} = this.state;
    return visible && route.screen === 'thread' && route.conversationId === conversationId;
  }

  private patchConversation(id: string, patch: Partial<ConversationSummary>): void {
    this.set({
      conversations: this.state.conversations.map(conversation =>
        conversation.id === id ? {...conversation, ...patch} : conversation,
      ),
    });
  }

  private async visitorId(): Promise<string> {
    const key = this.visitorKey();
    const stored = await this.storage.getItem(key).catch(() => null);
    if (stored) {
      return stored;
    }
    const created = generateVisitorId();
    await this.storage.setItem(key, created).catch(() => undefined);
    return created;
  }

  private visitorKey(): string {
    return `plunk.messenger.visitor.${this.config.publicKey}`;
  }

  private set(patch: Partial<MessengerState>): void {
    this.state = {...this.state, ...patch};
    for (const listener of this.listeners) {
      listener();
    }
    const unread = this.getUnreadConversationCount();
    if (unread !== this.lastUnread) {
      this.lastUnread = unread;
      for (const listener of this.unreadListeners) {
        listener(unread);
      }
    }
  }
}
