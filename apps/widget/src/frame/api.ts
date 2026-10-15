import {type EventStream, openEventStream} from '@plunk/shared/event-stream';
import type {
  ChatAttachmentLink,
  MessengerBootResponse,
  MessengerConversation,
  MessengerConversationSummary,
  MessengerEmailResponse,
  MessengerMessage,
  MessengerStartResponse,
} from '@plunk/types';

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

/**
 * Talks to the messenger API on the frame's own origin. The session token lives only in memory and
 * is re-issued by booting again whenever the API reports it as expired.
 */
export class MessengerApi {
  private token: string | null = null;

  public constructor(
    private readonly publicKey: string,
    private readonly visitorId: string,
    private readonly parentOrigin?: string,
    private readonly userToken?: string,
  ) {}

  public async boot(): Promise<MessengerBootResponse> {
    const data = await this.request<MessengerBootResponse>('POST', '/v1/messenger/boot', {
      auth: this.publicKey,
      body: {visitorId: this.visitorId, parentOrigin: this.parentOrigin, userToken: this.userToken},
    });
    this.token = data.token;
    return data;
  }

  public listConversations(): Promise<MessengerConversationSummary[]> {
    return this.withSession('GET', '/v1/messenger/conversations');
  }

  public async startConversation(body: string, turnstileToken?: string): Promise<MessengerConversation> {
    const data = await this.withSession<MessengerStartResponse>('POST', '/v1/messenger/conversations', {
      body,
      turnstileToken,
    });
    this.token = data.token;
    return data.conversation;
  }

  public getConversation(id: string): Promise<MessengerConversation> {
    return this.withSession('GET', `/v1/messenger/conversations/${encodeURIComponent(id)}`);
  }

  public sendMessage(id: string, body: string): Promise<MessengerMessage> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/messages`, {body});
  }

  public sendAttachment(id: string, file: File, body: string): Promise<MessengerMessage> {
    const form = new FormData();
    form.append('body', body);
    form.append('file', file);
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/attachments`, form);
  }

  public attachmentLink(conversationId: string, attachmentId: string): Promise<ChatAttachmentLink> {
    return this.withSession(
      'GET',
      `/v1/messenger/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  public typing(id: string): Promise<void> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/typing`, {});
  }

  public openStream(handlers: {onEvent: (data: string) => void; onOpen: () => void; onDisconnect: () => void}): EventStream {
    return openEventStream({
      url: '/v1/messenger/stream',
      headers: async () => {
        if (!this.token) {
          await this.boot();
        }
        return {Authorization: `Bearer ${this.token}`};
      },
      onUnauthorized: async () => {
        await this.boot().catch(() => undefined);
      },
      ...handlers,
    });
  }

  public async captureEmail(conversationId: string, email: string, subscribe: boolean): Promise<void> {
    const data = await this.withSession<MessengerEmailResponse>('POST', '/v1/messenger/email', {
      conversationId,
      email,
      subscribe,
    });
    this.token = data.token;
  }

  public markRead(id: string): Promise<void> {
    return this.withSession('POST', `/v1/messenger/conversations/${encodeURIComponent(id)}/read`, {});
  }

  private async withSession<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      await this.boot();
    }
    try {
      return await this.request<T>(method, path, {auth: this.token!, body});
    } catch (error) {
      if (error instanceof MessengerApiError && error.status === 401) {
        await this.boot();
        return this.request<T>(method, path, {auth: this.token!, body});
      }
      throw error;
    }
  }

  private async request<T>(method: string, path: string, options: {auth: string; body?: unknown}): Promise<T> {
    const form = options.body instanceof FormData;
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${options.auth}`,
        ...(options.body !== undefined && !form ? {'Content-Type': 'application/json'} : {}),
      },
      body: form ? (options.body as FormData) : options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      return undefined as T;
    }
    const payload = (await response.json().catch(() => ({}))) as Envelope<T>;
    if (!response.ok || !payload.success) {
      throw new MessengerApiError(response.status, payload.error?.message ?? 'Something went wrong');
    }
    return payload.data as T;
  }
}
