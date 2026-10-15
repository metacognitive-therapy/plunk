const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN_WAIT_MS = 15_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance: 'interaction-only';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Runs Cloudflare's bot check in a container and hands out one token per new conversation. With
 * `interaction-only` the check is invisible unless Cloudflare needs the visitor to click.
 */
export class HumanCheck {
  private widgetId: string | null = null;
  private api: TurnstileApi | null = null;
  private token: string | null = null;
  private waiters: ((token: string | null) => void)[] = [];

  public constructor(private readonly siteKey: string) {}

  public async mount(container: HTMLElement): Promise<void> {
    this.api = await loadScript();
    this.widgetId = this.api.render(container, {
      sitekey: this.siteKey,
      appearance: 'interaction-only',
      callback: token => this.settle(token),
      'expired-callback': () => {
        this.token = null;
      },
      'error-callback': () => this.settle(null),
    });
  }

  public unmount(): void {
    if (this.api && this.widgetId) {
      this.api.remove(this.widgetId);
    }
    this.widgetId = null;
    this.settle(null);
  }

  /** Resolves with a fresh token, or null when the check failed or took too long. */
  public take(): Promise<string | null> {
    if (this.token) {
      return Promise.resolve(this.consume());
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== done);
        resolve(null);
      }, TOKEN_WAIT_MS);
      const done = (token: string | null) => {
        clearTimeout(timer);
        resolve(token ? this.consume() : null);
      };
      this.waiters.push(done);
    });
  }

  /* A token is single use, so the widget starts on the next one straight away. */
  private consume(): string | null {
    const token = this.token;
    this.token = null;
    if (this.api && this.widgetId) {
      this.api.reset(this.widgetId);
    }
    return token;
  }

  private settle(token: string | null): void {
    this.token = token;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach(waiter => waiter(token));
  }
}
