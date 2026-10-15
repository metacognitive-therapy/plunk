import {afterEach, describe, expect, it, vi} from 'vitest';

import {xhrTransport} from '../xhr-transport';

/** Mimics React Native's XMLHttpRequest: progress events carry the whole text received so far. */
class FakeXhr {
  public static last: FakeXhr;
  public readyState = 0;
  public status = 0;
  public responseText = '';
  public withCredentials = false;
  public headers: Record<string, string> = {};
  public url = '';
  public onreadystatechange: (() => void) | null = null;
  public onprogress: (() => void) | null = null;
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public aborted = false;

  public constructor() {
    FakeXhr.last = this;
  }

  public open(_method: string, url: string) {
    this.url = url;
  }

  public setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  public send() {}

  public abort() {
    this.aborted = true;
    this.onabort?.();
  }

  public respond(status: number) {
    this.status = status;
    this.readyState = 2;
    this.onreadystatechange?.();
  }

  public receive(text: string) {
    this.readyState = 3;
    this.responseText += text;
    this.onprogress?.();
  }

  public end() {
    this.readyState = 4;
    this.onload?.();
  }
}

async function collect(iterable: AsyncIterable<string>, count: number): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
    if (out.length === count) {
      break;
    }
  }
  return out;
}

describe('xhrTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the headers and yields only the new text of each progress event', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController();
    const pending = xhrTransport({url: 'https://api.example.com/stream', headers: {Authorization: 'Bearer t'}, signal: controller.signal});
    const xhr = FakeXhr.last;
    xhr.respond(200);
    const response = await pending;

    expect(response).toMatchObject({status: 200, ok: true});
    expect(xhr.headers).toEqual({Authorization: 'Bearer t'});
    const chunks = collect(response.chunks!, 2);
    xhr.receive('data: {"type":"ready"}\n\n');
    xhr.receive('data: {"type":"typing"}\n\n');
    expect(await chunks).toEqual(['data: {"type":"ready"}\n\n', 'data: {"type":"typing"}\n\n']);
  });

  it('reports a refused stream without a body', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = xhrTransport({url: 'u', headers: {}, signal: new AbortController().signal});
    FakeXhr.last.respond(401);

    expect(await pending).toEqual({status: 401, ok: false, chunks: null});
  });

  it('ends the chunks when aborted', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController();
    const pending = xhrTransport({url: 'u', headers: {}, signal: controller.signal});
    const xhr = FakeXhr.last;
    xhr.respond(200);
    const response = await pending;
    const drained = collect(response.chunks!, 10);

    controller.abort();

    expect(await drained).toEqual([]);
    expect(xhr.aborted).toBe(true);
  });

  it('rejects on a network error before any response', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = xhrTransport({url: 'u', headers: {}, signal: new AbortController().signal});
    FakeXhr.last.onerror?.();

    await expect(pending).rejects.toThrow('Network error');
  });
});
