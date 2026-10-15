import type {MessengerBootResponse, MessengerConversation, MessengerConversationSummary} from '@plunk/types';
import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';

import {MessengerApi} from './api';
import {type Strings, stringsFor} from './strings';

const POLL_INTERVAL_MS = 4000;

type View = {name: 'home'} | {name: 'thread'; conversationId: string | null};

interface AppProps {
  publicKey: string;
  visitorId: string;
  parentOrigin?: string;
}

export function App({publicKey, visitorId, parentOrigin}: AppProps) {
  const api = useMemo(() => new MessengerApi(publicKey, visitorId, parentOrigin), [publicKey, visitorId, parentOrigin]);
  const [boot, setBoot] = useState<MessengerBootResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({name: 'home'});
  const [conversations, setConversations] = useState<MessengerConversationSummary[]>([]);

  const strings = stringsFor(boot?.project.language);

  useEffect(() => {
    if (!publicKey) {
      setFailed(true);
      return;
    }
    api
      .boot()
      .then(setBoot)
      .catch(() => setFailed(true));
  }, [api, publicKey]);

  const refreshList = useCallback(() => {
    api
      .listConversations()
      .then(setConversations)
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!boot || view.name !== 'home') {
      return;
    }
    refreshList();
    const timer = setInterval(refreshList, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [boot, view.name, refreshList]);

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
      />
      {view.name === 'home' ? (
        <Home
          strings={strings}
          conversations={conversations}
          onOpen={conversationId => setView({name: 'thread', conversationId})}
        />
      ) : (
        <Thread
          api={api}
          strings={strings}
          conversationId={view.conversationId}
          onStarted={conversationId => setView({name: 'thread', conversationId})}
        />
      )}
    </div>
  );
}

function Header({boot, strings, onBack}: {boot: MessengerBootResponse; strings: Strings; onBack?: () => void}) {
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
    </header>
  );
}

function Home({
  strings,
  conversations,
  onOpen,
}: {
  strings: Strings;
  conversations: MessengerConversationSummary[];
  onOpen: (conversationId: string | null) => void;
}) {
  return (
    <main class="pm-home">
      <section class="pm-hero">
        <h1>{strings.greeting}</h1>
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
  onStarted,
}: {
  api: MessengerApi;
  strings: Strings;
  conversationId: string | null;
  onStarted: (conversationId: string) => void;
}) {
  const [conversation, setConversation] = useState<MessengerConversation | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const messageCount = conversation?.messages.length ?? 0;

  const refresh = useCallback(() => {
    if (!conversationId) {
      return;
    }
    api
      .getConversation(conversationId)
      .then(next => {
        setConversation(next);
        void api.markRead(conversationId).catch(() => undefined);
      })
      .catch(() => undefined);
  }, [api, conversationId]);

  useEffect(() => {
    refresh();
    if (!conversationId) {
      return;
    }
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [conversationId, refresh]);

  useEffect(() => {
    bottom.current?.scrollIntoView({block: 'end'});
  }, [messageCount]);

  const submit = async (event: Event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    setError(false);
    try {
      if (conversationId) {
        const message = await api.sendMessage(conversationId, body);
        setConversation(current => (current ? {...current, status: 'OPEN', messages: [...current.messages, message]} : current));
      } else {
        const started = await api.startConversation(body);
        setConversation(started);
        onStarted(started.id);
      }
      setDraft('');
    } catch {
      setError(true);
    } finally {
      setSending(false);
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
            <div class="pm-bubble">{message.body}</div>
            <div class="pm-time">{formatTime(message.createdAt)}</div>
          </div>
        ))}
        {conversation?.status === 'CLOSED' ? <div class="pm-notice">{strings.closed}</div> : null}
        <div ref={bottom} />
      </div>
      <form class="pm-composer" onSubmit={submit}>
        {error ? <div class="pm-error">{strings.failed}</div> : null}
        <div class="pm-composer-row">
          <textarea
            value={draft}
            rows={1}
            maxLength={5000}
            placeholder={strings.placeholder}
            aria-label={strings.placeholder}
            onInput={event => setDraft((event.target as HTMLTextAreaElement).value)}
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

function formatTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString([], {month: 'short', day: 'numeric'});
}
