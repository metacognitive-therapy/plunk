import {type EventStream, type EventStreamTransport, openEventStream} from '@plunk/shared/event-stream';

import type {
  AttachmentLink,
  BootResponse,
  Conversation,
  ConversationSummary,
  Message,
  PickedFile,
  StartResponse,
  UserAttributeValue,
} from './types';

export class MessengerApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: {message?: string};
}

export interface ClientOptions {
  apiUrl: string;
  publicKey: string;
  visitorId: string;
  getUserToken?: () => Promise<string>;
  transport?: EventStreamTransport;
}

/**
 * The messenger API for one visitor. A signed-in user's token is asked for on every boot, so a
 * session that expires mid-use comes back with a fresh token rather than the one it started with.
 */
export class MessengerClient {
  private token: string | null = null;
  private booting: Promise<BootResponse> | null = null;
  private readonly apiUrl: string;

  public constructor(private readonly options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
  }

  public boot(): Promise<BootResponse> {
    this.booting ??= this.bootOnce().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  public listConversations(): Promise<ConversationSummary[]> {
    return this.withSession('GET', '/v1/messenger/conversations');
  }

  public async startConversation(body: string): Promise<Conversation> {
    const data = await this.withSession<StartResponse>('POST', '/v1/messenger/conversations', {body});
    this.token = data.token;
    return data.conversation;
  }

  public getConversation(id: string): Promise<Conversation> {
    return this.withSession('GET', `/v1/messenger/conversations/${encodeURIComponent(id)}`);
  }

  public sendMessage(id: string, body: string): Promise<Message> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/messages`, {body});
  }

  public sendAttachment(id: string, file: PickedFile, body: string): Promise<Message> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/attachments`, () => {
      const form = new FormData();
      form.append('body', body);
      /* React Native's FormData uploads a {uri, name, type} object as the file at that uri. */
      form.append('file', {uri: file.uri, name: file.name, type: file.type} as unknown as Blob);
      return form;
    });
  }

  public attachmentLink(conversationId: string, attachmentId: string): Promise<AttachmentLink> {
    return this.withSession(
      'GET',
      `/v1/messenger/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  public typing(id: string): Promise<void> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/typing`, {});
  }

  public markRead(id: string): Promise<void> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/read`, {});
  }

  public registerPushToken(token: string): Promise<void> {
    return this.withSession('POST', '/v1/messenger/push-token', {token});
  }

  public removePushToken(token: string): Promise<void> {
    return this.withSession('POST', '/v1/messenger/push-token/remove', {token});
  }

  public updateUser(attributes: Record<string, UserAttributeValue>): Promise<void> {
    return this.withSession('POST', '/v1/messenger/user', {attributes});
  }

  public logEvent(name: string, data?: Record<string, UserAttributeValue>, occurredAt?: string): Promise<void> {
    return this.withSession('POST', '/v1/messenger/events', {name, data, occurredAt});
  }

  public openStream(handlers: {onEvent: (data: string) => void; onOpen: () => void; onDisconnect: () => void}): EventStream {
    return openEventStream({
      url: `${this.apiUrl}/v1/messenger/stream`,
      transport: this.options.transport,
      headers: async () => {
        if (!this.token) {
          await this.boot();
        }
        return {Authorization: `Bearer ${this.token}`};
      },
      onUnauthorized: async () => {
        this.token = null;
        await this.boot().catch(() => undefined);
      },
      ...handlers,
    });
  }

  private async bootOnce(): Promise<BootResponse> {
    const userToken = this.options.getUserToken ? await this.options.getUserToken() : undefined;
    const data = await this.request<BootResponse>('POST', '/v1/messenger/boot', {
      auth: this.options.publicKey,
      body: {visitorId: this.options.visitorId, userToken},
    });
    this.token = data.token;
    return data;
  }

  private async withSession<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      await this.boot();
    }
    try {
      return await this.request<T>(method, path, {auth: this.token!, body});
    } catch (error) {
      if (error instanceof MessengerApiError && error.status === 401) {
        this.token = null;
        await this.boot();
        return this.request<T>(method, path, {auth: this.token!, body});
      }
      throw error;
    }
  }

  private async request<T>(method: string, path: string, options: {auth: string; body?: unknown}): Promise<T> {
    /* A form is built per attempt: a retried upload must not reuse a body that was already sent. */
    const body = typeof options.body === 'function' ? (options.body as () => FormData)() : options.body;
    const url = `${this.apiUrl}${path}`;
    const response =
      body instanceof FormData
        ? await upload(method, url, options.auth, body)
        : await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${options.auth}`,
              ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          }).then(async res => ({status: res.status, text: await res.text().catch(() => '')}));

    if (response.status === 204) {
      return undefined as T;
    }
    const payload = parse<Envelope<T>>(response.text);
    if (response.status < 200 || response.status >= 300 || !payload.success) {
      throw new MessengerApiError(response.status, payload.error?.message ?? 'Something went wrong');
    }
    return payload.data as T;
  }
}

function parse<T>(text: string): Partial<T> {
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    return {};
  }
}

/*
 * Uploads go through XMLHttpRequest, which sends React Native's {uri, name, type} form parts as
 * files. Expo replaces the global fetch with one that refuses those parts.
 */
function upload(method: string, url: string, auth: string, form: FormData): Promise<{status: number; text: string}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Authorization', `Bearer ${auth}`);
    xhr.onload = () => resolve({status: xhr.status, text: xhr.responseText});
    xhr.onerror = () => reject(new TypeError('Network request failed'));
    xhr.ontimeout = xhr.onerror;
    xhr.send(form);
  });
}
