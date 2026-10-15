import type {EventStreamTransport} from '@plunk/shared/event-stream';

/*
 * React Native's fetch buffers the whole body, so a stream that never ends would never arrive.
 * XMLHttpRequest reports progress with the text received so far; each new slice is one chunk.
 */
export const xhrTransport: EventStreamTransport = request =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const queue: string[] = [];
    let offset = 0;
    let finished = false;
    let notify: (() => void) | null = null;
    let settled = false;

    const wake = () => {
      notify?.();
      notify = null;
    };
    const take = () => {
      const text = xhr.responseText ?? '';
      if (text.length > offset) {
        queue.push(text.slice(offset));
        offset = text.length;
      }
    };
    const finish = () => {
      finished = true;
      wake();
    };

    const chunks: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (finished) {
            return;
          }
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      },
    };

    const respond = () => {
      if (settled) {
        return;
      }
      settled = true;
      const ok = xhr.status >= 200 && xhr.status < 300;
      resolve({status: xhr.status, ok, chunks: ok ? chunks : null});
    };

    xhr.open('GET', request.url);
    for (const [name, value] of Object.entries(request.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.withCredentials = request.credentials === 'include';
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2 && xhr.status !== 0) {
        respond();
      }
    };
    xhr.onprogress = () => {
      take();
      wake();
    };
    xhr.onload = () => {
      respond();
      take();
      finish();
    };
    xhr.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error('Network error'));
      }
      finish();
    };
    xhr.onabort = xhr.onerror;

    request.signal.addEventListener('abort', () => {
      xhr.abort();
      finish();
    });
    xhr.send();
  });
