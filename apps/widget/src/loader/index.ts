import type {MessengerAppearance} from '@plunk/types';

import {
  type DistributiveOmit,
  type FrameMessage,
  type HostMessage,
  PROTOCOL,
  VISITOR_ID_PATTERN,
  contrastColor,
  generateVisitorId,
  isProtocolMessage,
} from '../shared/protocol';

type Command = 'boot' | 'show' | 'hide' | 'update' | 'shutdown';

interface BootOptions {
  key?: string;
}

interface PlunkChatFunction {
  (command: Command, options?: BootOptions): void;
  q?: IArguments[] | unknown[][];
}

declare global {
  interface Window {
    PlunkChat?: PlunkChatFunction;
  }
}

const COOKIE = 'plunk_chat_vid';
const ONE_YEAR_SECONDS = 31536000;
const BOOT_TIMEOUT_MS = 20000;

const CHAT_ICON =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1L4 21l4.2-2c1.2.4 2.5.5 3.8.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>';
const CLOSE_ICON =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const STYLES = `
.launcher{position:fixed;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:transform .15s}
.launcher:hover{transform:scale(1.06)}
.launcher[hidden],.panel[hidden]{display:none}
.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#ef4444;color:#fff;font:600 12px/20px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-sizing:border-box}
.panel{position:fixed;bottom:88px;width:380px;height:min(640px,calc(100vh - 108px));border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.18);background:#fff}
.panel iframe{width:100%;height:100%;border:0;display:block}
.left{left:20px}
.right{right:20px}
@media (max-width:480px){.panel.left,.panel.right{inset:0;width:100%;height:100%;border-radius:0}.launcher[aria-expanded=true]{display:none}}
`;

/* Scripts loaded with async still expose currentScript while they first run; the query is the
fallback for loaders injected by tag managers. */
const script =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>('script[src*="/widget/loader.js"]');
const loaderUrl = new URL(script?.src ?? '/widget/loader.js', location.href);
const FRAME_ORIGIN = loaderUrl.origin;
const FRAME_URL = new URL('./', loaderUrl).href;

interface Mounted {
  host: HTMLElement;
  frame: HTMLIFrameElement;
  panel: HTMLElement;
  launcher: HTMLButtonElement;
  badge: HTMLElement;
}

let mounted: Mounted | null = null;
let booted = false;
let open = false;
let openWhenBooted = false;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

function readVisitorId(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  const fromCookie = match?.[1];
  if (fromCookie && VISITOR_ID_PATTERN.test(fromCookie)) {
    return fromCookie;
  }
  try {
    const stored = localStorage.getItem(COOKIE);
    return stored && VISITOR_ID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeVisitorId(value: string | null): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = value
    ? `${COOKIE}=${value}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`
    : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  try {
    if (value) {
      localStorage.setItem(COOKIE, value);
    } else {
      localStorage.removeItem(COOKIE);
    }
  } catch {
    /* Storage can be blocked; the cookie alone still identifies the visitor. */
  }
}

function visitorId(): string {
  const existing = readVisitorId();
  if (existing) {
    writeVisitorId(existing);
    return existing;
  }
  const created = generateVisitorId();
  writeVisitorId(created);
  return created;
}

function post(message: DistributiveOmit<HostMessage, 'source'>): void {
  mounted?.frame.contentWindow?.postMessage({source: PROTOCOL, ...message}, FRAME_ORIGIN);
}

function setOpen(next: boolean): void {
  if (!mounted || !booted) {
    openWhenBooted = next;
    return;
  }
  open = next;
  mounted.panel.hidden = !next;
  mounted.launcher.innerHTML = next ? CLOSE_ICON : CHAT_ICON;
  mounted.badge.hidden ||= next;
  mounted.launcher.appendChild(mounted.badge);
  mounted.launcher.setAttribute('aria-label', next ? 'Close chat' : 'Open chat');
  mounted.launcher.setAttribute('aria-expanded', String(next));
  if (next) {
    post({type: 'opened'});
  }
}

function applyAppearance(appearance: MessengerAppearance): void {
  if (!mounted) {
    return;
  }
  const side = appearance.launcherPosition === 'LEFT' ? 'left' : 'right';
  for (const element of [mounted.launcher, mounted.panel]) {
    element.classList.remove('left', 'right');
    element.classList.add(side);
  }
  mounted.launcher.style.background = appearance.accentColor;
  mounted.launcher.style.color = contrastColor(appearance.accentColor);
}

function onMessage(event: MessageEvent): void {
  if (!mounted || event.source !== mounted.frame.contentWindow || event.origin !== FRAME_ORIGIN) {
    return;
  }
  if (!isProtocolMessage(event.data)) {
    return;
  }
  const message = event.data as FrameMessage;
  switch (message.type) {
    case 'ready':
      post({type: 'init', visitorId: visitorId()});
      break;
    case 'booted':
      clearTimeout(bootTimer);
      booted = true;
      applyAppearance(message.appearance);
      mounted.launcher.hidden = false;
      setOpen(openWhenBooted);
      break;
    case 'failed':
      teardown();
      break;
    case 'unread':
      mounted.badge.textContent = message.count > 9 ? '9+' : String(message.count);
      mounted.badge.hidden = message.count === 0 || open;
      break;
    case 'close':
      setOpen(false);
      break;
  }
}

function boot(options: BootOptions = {}): void {
  if (mounted || !options.key) {
    return;
  }

  const host = document.createElement('div');
  host.setAttribute('data-plunk-chat', '');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:0;right:0;width:0;height:0';
  const root = host.attachShadow({mode: 'closed'});

  const style = document.createElement('style');
  style.textContent = STYLES;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;

  const frame = document.createElement('iframe');
  frame.title = 'Chat';
  frame.allow = 'clipboard-write';
  const src = new URL(FRAME_URL);
  src.searchParams.set('key', options.key);
  src.searchParams.set('embed', '1');
  src.searchParams.set('parent', location.origin);
  frame.src = src.href;
  panel.appendChild(frame);

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.hidden = true;
  launcher.addEventListener('click', () => setOpen(!open));

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;

  launcher.innerHTML = CHAT_ICON;
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.appendChild(badge);

  root.append(style, panel, launcher);
  mounted = {host, frame, panel, launcher, badge};
  window.addEventListener('message', onMessage);
  document.body.appendChild(host);
  /* A frame refused by frame-ancestors never reports back, so a silent frame is removed. */
  bootTimer = setTimeout(() => {
    if (!booted) {
      teardown();
    }
  }, BOOT_TIMEOUT_MS);
}

function teardown(): void {
  clearTimeout(bootTimer);
  window.removeEventListener('message', onMessage);
  mounted?.host.remove();
  mounted = null;
  booted = false;
  open = false;
  openWhenBooted = false;
}

function run(command: Command, options?: BootOptions): void {
  switch (command) {
    case 'boot':
      if (document.body) {
        boot(options);
      } else {
        document.addEventListener('DOMContentLoaded', () => boot(options), {once: true});
      }
      break;
    case 'show':
      setOpen(true);
      break;
    case 'hide':
      setOpen(false);
      break;
    case 'update':
      post({type: 'update'});
      break;
    case 'shutdown':
      teardown();
      writeVisitorId(null);
      break;
  }
}

const queued = window.PlunkChat?.q ?? [];
const api: PlunkChatFunction = (command, options) => run(command, options);
window.PlunkChat = api;
for (const args of queued) {
  run(args[0] as Command, args[1] as BootOptions | undefined);
}
