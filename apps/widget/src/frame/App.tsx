import {CHAT_ATTACHMENT_ACCEPT, CHAT_ATTACHMENT_MAX_BYTES, formatFileSize, isInlineImage} from '@plunk/shared/attachments';
import type {
  ChatAttachment,
  MessengerBootResponse,
  MessengerConversation,
  MessengerConversationSummary,
  MessengerStreamEvent,
} from '@plunk/types';
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';

import {contrastColor} from '../shared/protocol';

import {MessengerApi, MessengerApiError} from './api';
import type {HostBridge} from './host';
import {type Strings, stringsFor} from './strings';
import {HumanCheck} from './turnstile';

/* Polling is only the fallback while the event stream is down. */
const FALLBACK_POLL_MS = 15_000;
const TYPING_SEND_INTERVAL_MS = 2500;
const TYPING_VISIBLE_MS = 4000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type StreamListener = (event: MessengerStreamEvent) => void;
type Subscribe = (listener: StreamListener) => () => void;

type View = {name: 'home'} | {name: 'thread'; conversationId: string | null};

interface AppProps {
  publicKey: string;
  visitorId: string;
  bridge?: HostBridge;
}

export function App({publicKey, visitorId, bridge}: AppProps) {
  const api = useMemo(
    () => new MessengerApi(publicKey, visitorId, bridge?.parentOrigin),
    [publicKey, visitorId, bridge],
  );
  const [boot, setBoot] = useState<MessengerBootResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({name: 'home'});
  const [conversations, setConversations] = useState<MessengerConversationSummary[]>([]);
  const [hasEmail, setHasEmail] = useState(true);

  const strings = stringsFor(boot?.project.language);

  useEffect(() => {
    if (!publicKey) {
      setFailed(true);
      return;
    }
    api
      .boot()
      .then(result => {
        applyAccent(result.appearance.accentColor);
        setHasEmail(result.visitor.hasEmail);
        setBoot(result);
        bridge?.post({type: 'booted', appearance: result.appearance});
      })
      .catch(() => {
        setFailed(true);
        bridge?.post({type: 'failed'});
      });
  }, [api, publicKey, bridge]);

  const [panelOpen, setPanelOpen] = useState(!bridge);
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible');
  const [streamConnected, setStreamConnected] = useState(false);
  const listeners = useRef(new Set<StreamListener>());

  const subscribe = useCallback<Subscribe>(listener => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const refreshList = useCallback(() => {
    api
      .listConversations()
      .then(setConversations)
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!boot) {
      return;
    }
    refreshList();
    const offs = [
      bridge?.on('opened', () => {
        setPanelOpen(true);
        refreshList();
      }),
      bridge?.on('closed', () => setPanelOpen(false)),
      bridge?.on('update', refreshList),
    ];
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      offs.forEach(off => off?.());
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [boot, refreshList, bridge]);

  /* A visitor who never chatted needs no stream until they open the messenger, which keeps idle
  page views from each holding a connection. The launcher badge needs one once a thread exists. */
  const wantsStream = Boolean(boot) && pageVisible && (panelOpen || conversations.length > 0);

  useEffect(() => {
    if (!wantsStream) {
      return;
    }
    const stream = api.openStream({
      onEvent: data => {
        const event = JSON.parse(data) as MessengerStreamEvent;
        if (event.type !== 'typing') {
          refreshList();
        }
        listeners.current.forEach(listener => listener(event));
      },
      onOpen: () => setStreamConnected(true),
      onDisconnect: () => setStreamConnected(false),
    });
    const onOnline = () => stream.reconnect();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      stream.close();
      setStreamConnected(false);
    };
  }, [api, wantsStream, refreshList]);

  useEffect(() => {
    if (!wantsStream || streamConnected) {
      return;
    }
    const timer = setInterval(refreshList, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [wantsStream, streamConnected, refreshList]);

  const onRead = useCallback((conversationId: string) => {
    setConversations(current =>
      current.map(conversation => (conversation.id === conversationId ? {...conversation, unread: false} : conversation)),
    );
  }, []);

  const unread = conversations.filter(conversation => conversation.unread).length;
  useEffect(() => {
    bridge?.post({type: 'unread', count: unread});
  }, [bridge, unread]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        bridge.post({type: 'close'});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge]);

  if (failed) {
    return (
      <div class="pm-shell">
        <div class="pm-empty">{strings.unavailable}</div>
      </div>
    );
  }

  if (!boot) {
    return <div class="pm-shell" aria-busy="true" />;
  }

  return (
    <div class="pm-shell">
      <Header
        boot={boot}
        strings={strings}
        onBack={view.name === 'thread' ? () => setView({name: 'home'}) : undefined}
        onClose={bridge ? () => bridge.post({type: 'close'}) : undefined}
      />
      {view.name === 'home' ? (
        <Home
          boot={boot}
          strings={strings}
          conversations={conversations}
          onOpen={conversationId => setView({name: 'thread', conversationId})}
        />
      ) : (
        <Thread
          api={api}
          strings={strings}
          conversationId={view.conversationId}
          turnstileSiteKey={boot.turnstileSiteKey}
          subscribe={subscribe}
          streamConnected={streamConnected}
          canMarkRead={panelOpen && pageVisible}
          askForEmail={!hasEmail}
          onEmailCaptured={() => setHasEmail(true)}
          onRead={onRead}
          onStarted={conversationId => setView({name: 'thread', conversationId})}
        />
      )}
    </div>
  );
}

function applyAccent(accent: string) {
  document.documentElement.style.setProperty('--pm-accent', accent);
  document.documentElement.style.setProperty('--pm-accent-contrast', contrastColor(accent));
}

function Header({
  boot,
  strings,
  onBack,
  onClose,
}: {
  boot: MessengerBootResponse;
  strings: Strings;
  onBack?: () => void;
  onClose?: () => void;
}) {
  return (
    <header class="pm-header">
      {onBack ? (
        <button class="pm-icon-button" type="button" aria-label={strings.back} onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      ) : null}
      {boot.project.logoUrl ? <img class="pm-logo" src={boot.project.logoUrl} alt="" /> : null}
      <div class="pm-title">{boot.project.name}</div>
      {onClose ? (
        <button class="pm-icon-button pm-close" type="button" aria-label={strings.close} onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      ) : null}
    </header>
  );
}

function Home({
  boot,
  strings,
  conversations,
  onOpen,
}: {
  boot: MessengerBootResponse;
  strings: Strings;
  conversations: MessengerConversationSummary[];
  onOpen: (conversationId: string | null) => void;
}) {
  return (
    <main class="pm-home">
      <section class="pm-hero">
        {boot.appearance.team.length > 0 ? (
          <div class="pm-team" aria-label={boot.appearance.team.map(member => member.name).join(', ')}>
            {boot.appearance.team.map(member => (
              <span key={member.id} class="pm-avatar" title={member.name}>
                {initials(member.name)}
              </span>
            ))}
          </div>
        ) : null}
        <h1>{boot.appearance.greeting ?? strings.greeting}</h1>
        <p>{strings.intro}</p>
        <button class="pm-primary" type="button" onClick={() => onOpen(null)}>
          {strings.newConversation}
        </button>
      </section>
      {conversations.length > 0 ? (
        <section class="pm-card">
          <h2>{strings.yourConversations}</h2>
          <ul class="pm-list">
            {conversations.map(conversation => (
              <li key={conversation.id}>
                <button type="button" class="pm-list-item" onClick={() => onOpen(conversation.id)}>
                  <span class="pm-list-preview">
                    {conversation.lastMessage
                      ? `${conversation.lastMessage.authorType === 'CONTACT' ? `${strings.you}: ` : ''}${conversation.lastMessage.body}`
                      : ''}
                  </span>
                  <span class="pm-list-meta">
                    {formatTime(conversation.lastMessageAt)}
                    {conversation.unread ? <span class="pm-dot" aria-label="unread" /> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function Thread({
  api,
  strings,
  conversationId,
  turnstileSiteKey,
  subscribe,
  streamConnected,
  canMarkRead,
  askForEmail,
  onEmailCaptured,
  onRead,
  onStarted,
}: {
  api: MessengerApi;
  strings: Strings;
  conversationId: string | null;
  turnstileSiteKey: string | null;
  subscribe: Subscribe;
  streamConnected: boolean;
  canMarkRead: boolean;
  askForEmail: boolean;
  onEmailCaptured: () => void;
  onRead: (conversationId: string) => void;
  onStarted: (conversationId: string) => void;
}) {
  const [conversation, setConversation] = useState<MessengerConversation | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState<{name: string | null} | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastMarkedRead = useRef<string | null>(null);
  const lastTypingSent = useRef(0);
  const [capturedEmail, setCapturedEmail] = useState<string | null>(null);
  const messageCount = conversation?.messages.length ?? 0;
  const humanCheckContainer = useRef<HTMLDivElement>(null);
  const humanCheck = useRef<HumanCheck | null>(null);

  /* Only a new conversation needs the bot check; replies in an existing one ride on its session. */
  const needsHumanCheck = Boolean(turnstileSiteKey) && !conversationId;
  useEffect(() => {
    if (!needsHumanCheck || !humanCheckContainer.current) {
      return;
    }
    const check = new HumanCheck(turnstileSiteKey!);
    humanCheck.current = check;
    void check.mount(humanCheckContainer.current).catch(() => undefined);
    return () => {
      check.unmount();
      humanCheck.current = null;
    };
  }, [needsHumanCheck, turnstileSiteKey]);

  const refresh = useCallback(() => {
    if (!conversationId) {
      return;
    }
    api
      .getConversation(conversationId)
      .then(setConversation)
      .catch(() => undefined);
  }, [api, conversationId]);

  const append = useCallback((message: MessengerConversation['messages'][number]) => {
    setConversation(current =>
      current && !current.messages.some(existing => existing.id === message.id)
        ? {...current, messages: [...current.messages, message]}
        : current,
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      if (event.type === 'ready') {
        refresh();
        return;
      }
      if (event.conversationId !== conversationId) {
        return;
      }
      if (event.type === 'message') {
        append(event.message);
        if (event.message.authorType !== 'CONTACT') {
          setTyping(null);
        }
      } else if (event.type === 'conversation') {
        setConversation(current => (current ? {...current, status: event.status} : current));
      } else if (event.type === 'typing') {
        setTyping({name: event.agentName});
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => setTyping(null), TYPING_VISIBLE_MS);
      }
    });
    return () => {
      off();
      clearTimeout(typingTimer);
    };
  }, [conversationId, subscribe, refresh, append]);

  useEffect(() => {
    if (!conversationId || streamConnected) {
      return;
    }
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [conversationId, streamConnected, refresh]);

  /* Read only while the visitor can actually see the thread: the frame stays mounted while the
  panel is closed, and agents are told the visitor has seen their reply. */
  useEffect(() => {
    const last = conversation?.messages[conversation.messages.length - 1];
    if (!conversationId || !canMarkRead || !last || last.authorType === 'CONTACT' || lastMarkedRead.current === last.id) {
      return;
    }
    lastMarkedRead.current = last.id;
    api
      .markRead(conversationId)
      .then(() => onRead(conversationId))
      .catch(() => {
        lastMarkedRead.current = null;
      });
  }, [api, conversation, conversationId, canMarkRead, onRead]);

  useEffect(() => {
    bottom.current?.scrollIntoView({block: 'end'});
  }, [messageCount, typing]);

  const onDraft = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (conversationId && value.trim() && now - lastTypingSent.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSent.current = now;
      void api.typing(conversationId).catch(() => undefined);
    }
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      if (conversationId) {
        const message = await api.sendMessage(conversationId, body);
        append(message);
        setConversation(current => (current ? {...current, status: 'OPEN'} : current));
      } else {
        let token: string | undefined;
        if (humanCheck.current) {
          token = (await humanCheck.current.take()) ?? undefined;
          if (!token) {
            setError(strings.humanCheckFailed);
            return;
          }
        }
        const started = await api.startConversation(body, token);
        setConversation(started);
        onStarted(started.id);
      }
      setDraft('');
    } catch (caught) {
      setError(sendError(caught, strings));
    } finally {
      setSending(false);
    }
  };

  /* The draft goes with the file as its caption, so a visitor can say what they are sending. */
  const attach = async (file: File | undefined) => {
    if (!file || !conversationId || uploading) {
      return;
    }
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      setError(strings.attachmentTooLarge);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const message = await api.sendAttachment(conversationId, file, draft.trim());
      append(message);
      setConversation(current => (current ? {...current, status: 'OPEN'} : current));
      setDraft('');
    } catch (caught) {
      setError(
        caught instanceof MessengerApiError && caught.status < 500 && caught.status !== 429
          ? caught.message
          : sendError(caught, strings),
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <main class="pm-thread">
      <div class="pm-messages" role="log" aria-live="polite">
        {conversation?.messages.map(message => (
          <div key={message.id} class={`pm-message ${message.authorType === 'CONTACT' ? 'pm-mine' : 'pm-theirs'}`}>
            {message.authorType !== 'CONTACT' ? (
              <div class="pm-author">{message.agent?.name ?? strings.team}</div>
            ) : null}
            {message.body ? <div class="pm-bubble">{message.body}</div> : null}
            {message.attachments.map(attachment => (
              <Attachment
                key={attachment.id}
                api={api}
                strings={strings}
                conversationId={conversationId!}
                attachment={attachment}
              />
            ))}
            <div class="pm-time">{formatTime(message.createdAt)}</div>
          </div>
        ))}
        {typing ? (
          <div class="pm-message pm-theirs">
            <div class="pm-author">{typing.name ?? strings.team}</div>
            <div class="pm-bubble pm-typing" role="status" aria-label={strings.typing}>
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
        {conversationId && askForEmail && conversation?.messages.some(message => message.authorType === 'CONTACT') ? (
          <EmailPrompt
            api={api}
            strings={strings}
            conversationId={conversationId}
            onCaptured={email => {
              setCapturedEmail(email);
              onEmailCaptured();
            }}
          />
        ) : null}
        {capturedEmail ? (
          <div class="pm-notice">
            {strings.emailSaved} <strong>{capturedEmail}</strong>
          </div>
        ) : null}
        {conversation?.status === 'CLOSED' ? <div class="pm-notice">{strings.closed}</div> : null}
        <div ref={bottom} />
      </div>
      <form class="pm-composer" onSubmit={submit}>
        {needsHumanCheck ? <div ref={humanCheckContainer} class="pm-human-check" /> : null}
        {error ? (
          <div class="pm-error" role="alert">
            {error}
          </div>
        ) : null}
        <div class="pm-composer-row">
          {conversationId ? (
            <>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept={CHAT_ATTACHMENT_ACCEPT}
                onChange={event => {
                  const input = event.target as HTMLInputElement;
                  void attach(input.files?.[0]);
                  input.value = '';
                }}
              />
              <button
                class="pm-attach"
                type="button"
                disabled={uploading}
                aria-label={strings.attach}
                title={strings.attach}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <span class="pm-spinner" aria-hidden="true" />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path
                      d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                )}
              </button>
            </>
          ) : null}
          <textarea
            value={draft}
            rows={1}
            maxLength={5000}
            placeholder={strings.placeholder}
            aria-label={strings.placeholder}
            onInput={event => onDraft((event.target as HTMLTextAreaElement).value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                void submit(event);
              }
            }}
          />
          <button class="pm-send" type="submit" disabled={sending || !draft.trim()} aria-label={strings.send}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.99.99 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </div>
      </form>
    </main>
  );
}

function sendError(caught: unknown, strings: Strings): string {
  if (caught instanceof MessengerApiError) {
    if (caught.status === 429) {
      return strings.tooFast;
    }
    if (caught.status === 403) {
      return strings.humanCheckFailed;
    }
  }
  return strings.failed;
}

/* Links are fetched on demand and expire after a few minutes, so a broken image or a later
download asks for a fresh one instead of reusing a stale URL. */
function Attachment({
  api,
  strings,
  conversationId,
  attachment,
}: {
  api: MessengerApi;
  strings: Strings;
  conversationId: string;
  attachment: ChatAttachment;
}) {
  const image = isInlineImage(attachment.contentType);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);

  const load = useCallback(
    () =>
      api
        .attachmentLink(conversationId, attachment.id)
        .then(link => link.url)
        .catch(() => {
          setFailed(true);
          return null;
        }),
    [api, conversationId, attachment.id],
  );

  useEffect(() => {
    if (image) {
      void load().then(setSrc);
    }
  }, [image, load]);

  const save = async () => {
    const url = await load();
    if (!url) {
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  if (image && !failed) {
    return (
      <button type="button" class="pm-image" onClick={() => void save()} title={attachment.filename}>
        {src ? (
          <img
            src={src}
            alt={attachment.filename}
            onError={() => {
              if (retried.current) {
                setFailed(true);
                return;
              }
              retried.current = true;
              void load().then(setSrc);
            }}
          />
        ) : (
          <span class="pm-image-placeholder" aria-busy="true" />
        )}
      </button>
    );
  }

  return (
    <button type="button" class="pm-file" onClick={() => void save()} aria-label={`${strings.download} ${attachment.filename}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke-linejoin="round" />
        <path d="M14 2v6h6" stroke-linejoin="round" />
      </svg>
      <span class="pm-file-name">{attachment.filename}</span>
      <span class="pm-file-size">{failed ? strings.attachmentFailed : formatFileSize(attachment.size)}</span>
    </button>
  );
}

function EmailPrompt({
  api,
  strings,
  conversationId,
  onCaptured,
}: {
  api: MessengerApi;
  strings: Strings;
  conversationId: string;
  onCaptured: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [subscribe, setSubscribe] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setError(strings.emailInvalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.captureEmail(conversationId, value, subscribe);
      onCaptured(value.toLowerCase());
    } catch (caught) {
      setError(
        caught instanceof MessengerApiError && caught.status === 409
          ? caught.message
          : caught instanceof MessengerApiError && caught.status === 422
            ? strings.emailInvalid
            : strings.failed,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form class="pm-email" onSubmit={submit} noValidate>
      <div class="pm-email-title">{strings.emailPrompt}</div>
      <div class="pm-email-hint">{strings.emailHint}</div>
      <div class="pm-email-row">
        <input
          type="email"
          autocomplete="email"
          inputMode="email"
          value={email}
          maxLength={254}
          placeholder={strings.emailPlaceholder}
          aria-label={strings.emailPrompt}
          aria-invalid={error ? 'true' : undefined}
          onInput={event => setEmail((event.target as HTMLInputElement).value)}
        />
        <button type="submit" disabled={saving || !email.trim()}>
          {saving ? strings.emailSaving : strings.emailSave}
        </button>
      </div>
      <label class="pm-email-consent">
        <input
          type="checkbox"
          checked={subscribe}
          onChange={event => setSubscribe((event.target as HTMLInputElement).checked)}
        />
        {strings.emailConsent}
      </label>
      {error ? (
        <div class="pm-error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString([], {month: 'short', day: 'numeric'});
}
