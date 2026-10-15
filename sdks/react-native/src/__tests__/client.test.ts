import {afterEach, describe, expect, it, vi} from 'vitest';

import {MessengerClient} from '../client';

const API = 'https://api.example.com';

/** Records each upload and answers it with the next queued status. */
class FakeXhr {
  public static sent: {url: string; auth: string; form: FormData}[] = [];
  public static statuses: number[] = [];
  public status = 0;
  public responseText = '';
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public ontimeout: (() => void) | null = null;
  private url = '';
  private auth = '';

  public open(_method: string, url: string) {
    this.url = url;
  }

  public setRequestHeader(name: string, value: string) {
    if (name === 'Authorization') {
      this.auth = value;
    }
  }

  public send(form: FormData) {
    FakeXhr.sent.push({url: this.url, auth: this.auth, form});
    this.status = FakeXhr.statuses.shift() ?? 200;
    this.responseText = JSON.stringify(
      this.status === 200
        ? {success: true, data: {id: 'm1', authorType: 'CONTACT', body: 'see attached', attachments: [], createdAt: ''}}
        : {success: false, error: {message: 'Session expired'}},
    );
    queueMicrotask(() => this.onload?.());
  }
}

function bootingFetch() {
  let sessions = 0;
  return vi.fn(async () => new Response(JSON.stringify({success: true, data: {token: `session-${++sessions}`}}), {status: 200}));
}

describe('MessengerClient uploads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeXhr.sent = [];
    FakeXhr.statuses = [];
  });

  it('sends the picked file through XMLHttpRequest, which accepts React Native file parts', async () => {
    vi.stubGlobal('fetch', bootingFetch());
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const client = new MessengerClient({apiUrl: API, publicKey: 'pk_test', visitorId: 'visitor-1234567890'});

    const message = await client.sendAttachment('c1', {uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg'}, 'see attached');

    expect(message).toMatchObject({id: 'm1'});
    expect(FakeXhr.sent).toHaveLength(1);
    expect(FakeXhr.sent[0]).toMatchObject({url: `${API}/v1/messenger/conversations/c1/attachments`, auth: 'Bearer session-1'});
    expect((FakeXhr.sent[0]!.form as unknown as {get(name: string): unknown}).get('body')).toBe('see attached');
  });

  it('re-boots and sends a fresh form when the session has expired', async () => {
    vi.stubGlobal('fetch', bootingFetch());
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.statuses = [401, 200];
    const client = new MessengerClient({apiUrl: API, publicKey: 'pk_test', visitorId: 'visitor-1234567890'});

    await client.sendAttachment('c1', {uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg'}, '');

    expect(FakeXhr.sent.map(upload => upload.auth)).toEqual(['Bearer session-1', 'Bearer session-2']);
    expect(FakeXhr.sent[1]!.form).not.toBe(FakeXhr.sent[0]!.form);
  });
});
