import {Button, EmptyState, IconSpinner} from '@plunk/ui';
import {CONVERSATION_VIEWS, type ConversationView} from '@plunk/shared';
import type {
  InboxConversation,
  InboxConversationSummary,
  InboxCounts,
  InboxMessage,
  InboxPage,
  InboxStreamEvent,
  InboxSystemEvent,
} from '@plunk/types';
import {AlarmClock, ArrowLeft, Inbox as InboxIcon, MessageSquare, StickyNote} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useCallback, useEffect, useRef, useState} from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import {DashboardLayout} from '../../components/DashboardLayout';
import {Composer} from '../../components/inbox/Composer';
import {ConversationActions, formatSnoozeDate} from '../../components/inbox/ConversationActions';
import {formatRelativeTime} from '../../lib/dateUtils';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useInboxStream} from '../../lib/hooks/useInboxStream';
import {useSupportAccess} from '../../lib/hooks/useSupportAccess';
import {useUser} from '../../lib/hooks/useUser';
import {network} from '../../lib/network';

/* Polling is only the fallback while the event stream is down. */
const LIST_REFRESH_MS = 10_000;
const THREAD_REFRESH_MS = 5_000;
const LIST_REFRESH_DEBOUNCE_MS = 250;
const TYPING_VISIBLE_MS = 4000;
const PAGE_SIZE = 30;

type StreamListener = (event: InboxStreamEvent) => void;
type Subscribe = (listener: StreamListener) => () => void;

const VIEW_LABELS: Record<ConversationView, string> = {
  unassigned: 'Unassigned',
  mine: 'Mine',
  all: 'All',
  closed: 'Closed',
};

function countLabel(counts: InboxCounts | undefined, view: ConversationView): string | null {
  if (!counts) return null;
  const value = counts[view];
  return value >= counts.cap ? `${counts.cap}+` : String(value);
}

function describeSystemEvent(event: InboxSystemEvent, actor: {id: string; name: string} | null, me: string | undefined): string {
  const who = actor ? (actor.id === me ? 'You' : actor.name) : 'Someone';
  switch (event.action) {
    case 'closed':
      return `${who} closed the conversation`;
    case 'reopened':
      if (event.trigger === 'contact') return 'Reopened by a new message from the visitor';
      if (event.trigger === 'snooze_expired') return 'Snooze ended, back in Open';
      return `${who} reopened the conversation`;
    case 'snoozed':
      return event.until
        ? `${who} snoozed this until ${formatSnoozeDate(event.until)}`
        : `${who} snoozed this until the visitor replies`;
    case 'assigned':
      if (actor && event.assignee.id === actor.id) {
        return actor.id === me ? 'You assigned this to yourself' : `${who} assigned this to themselves`;
      }
      return `${who} assigned this to ${event.assignee.id === me ? 'you' : event.assignee.name}`;
    case 'unassigned':
      return `${who} unassigned this conversation`;
  }
}

function contactLabel(contact: InboxConversationSummary['contact']): string {
  const data = contact.data ?? {};
  const name = [data.firstName, data.lastName].filter(part => typeof part === 'string' && part).join(' ');
  return name || contact.email || contact.externalId || 'Anonymous visitor';
}

export default function InboxPageView() {
  const router = useRouter();
  const {activeProject} = useActiveProject();
  const {data: user} = useUser();
  const hasAccess = useSupportAccess();
  const view = (CONVERSATION_VIEWS as readonly string[]).includes(router.query.view as string)
    ? (router.query.view as ConversationView)
    : 'all';
  const selectedId = typeof router.query.c === 'string' ? router.query.c : null;

  const setQuery = (next: {view?: ConversationView; c?: string | null}) => {
    const query: Record<string, string> = {view: next.view ?? view};
    const conversation = next.c === undefined ? selectedId : next.c;
    if (conversation) query.c = conversation;
    void router.replace({pathname: '/inbox', query}, undefined, {shallow: true});
  };

  const listeners = useRef(new Set<StreamListener>());
  const subscribe = useCallback<Subscribe>(listener => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const connected = useInboxStream(activeProject?.id, hasAccess, event => {
    listeners.current.forEach(listener => listener(event));
  });

  const {data, size, setSize, mutate, isLoading, error} = useSWRInfinite<{success: boolean; data: InboxPage}>(
    (index, previous) => {
      if (!activeProject?.id || !hasAccess) return null;
      if (previous && !previous.data.nextCursor) return null;
      const cursor = previous?.data.nextCursor ? `&cursor=${encodeURIComponent(previous.data.nextCursor)}` : '';
      return `/conversations?view=${view}&limit=${PAGE_SIZE}${cursor}`;
    },
    {refreshInterval: connected ? 0 : LIST_REFRESH_MS, revalidateFirstPage: true},
  );
  const {data: counts, mutate: mutateCounts} = useSWR<{success: boolean; data: InboxCounts}>(
    activeProject?.id && hasAccess ? '/conversations/counts' : null,
    {refreshInterval: connected ? 0 : LIST_REFRESH_MS},
  );
  const refreshList = useCallback(() => {
    void mutate();
    void mutateCounts();
  }, [mutate, mutateCounts]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      const ownRead = event.type === 'read' && event.reader.type === 'AGENT' && event.reader.userId === user?.id;
      if (event.type === 'ready' || event.type === 'message' || event.type === 'conversation' || ownRead) {
        clearTimeout(timer);
        timer = setTimeout(refreshList, LIST_REFRESH_DEBOUNCE_MS);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [subscribe, refreshList, user?.id]);

  const conversations = data?.flatMap(page => page.data.conversations) ?? [];
  const hasMore = Boolean(data?.[data.length - 1]?.data.nextCursor);

  return (
    <>
      <NextSeo title="Inbox" />
      <DashboardLayout>
        {!hasAccess ? (
          <EmptyState
            icon={InboxIcon}
            title="The inbox is for support agents"
            description="Ask a project owner or admin to turn on inbox access for you in Settings, Team."
          />
        ) : (
          <div className="flex h-[calc(100vh-8rem)] min-h-[480px] overflow-hidden rounded-lg border border-neutral-200 bg-white lg:h-[calc(100vh-4rem)]">
            <aside
              className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-neutral-200 md:w-80 md:shrink-0`}
            >
              <div className="border-b border-neutral-200 px-4 py-3">
                <h1 className="text-lg font-semibold text-neutral-900">Inbox</h1>
                <div className="mt-3 flex flex-wrap gap-0.5" role="tablist">
                  {CONVERSATION_VIEWS.map(option => (
                    <button
                      key={option}
                      role="tab"
                      aria-selected={view === option}
                      onClick={() => setQuery({view: option, c: null})}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        view === option ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
                      }`}
                    >
                      {VIEW_LABELS[option]}
                      {countLabel(counts?.data, option) !== null && (
                        <span className={`ml-1.5 tabular-nums ${view === option ? 'text-neutral-300' : 'text-neutral-400'}`}>
                          {countLabel(counts?.data, option)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                  <div className="flex justify-center py-10">
                    <IconSpinner />
                  </div>
                ) : error && conversations.length === 0 ? (
                  <EmptyState icon={MessageSquare} title="Couldn’t load conversations" description="Retrying shortly." />
                ) : conversations.length === 0 ? (
                  <EmptyState icon={MessageSquare} title="No conversations" description="Nothing in this view yet." />
                ) : (
                  <ul>
                    {conversations.map(conversation => (
                      <li key={conversation.id}>
                        <button
                          onClick={() => setQuery({c: conversation.id})}
                          className={`w-full border-b border-neutral-100 px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${
                            selectedId === conversation.id ? 'bg-neutral-100' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-sm ${conversation.unread ? 'font-semibold text-neutral-900' : 'text-neutral-700'}`}
                            >
                              {contactLabel(conversation.contact)}
                            </span>
                            <span className="shrink-0 text-xs text-neutral-400">
                              {formatRelativeTime(conversation.lastMessageAt)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="truncate text-xs text-neutral-500">
                              {conversation.lastMessage?.authorType === 'AGENT' ? 'You: ' : ''}
                              {conversation.lastMessage?.body}
                            </span>
                            {conversation.status === 'SNOOZED' && (
                              <span
                                className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-amber-700"
                                title={
                                  conversation.snoozedUntil
                                    ? `Snoozed until ${formatSnoozeDate(conversation.snoozedUntil)}`
                                    : 'Snoozed until the visitor replies'
                                }
                              >
                                <AlarmClock className="h-3 w-3" />
                                Snoozed
                              </span>
                            )}
                            {conversation.unread && (
                              <span
                                className={`${conversation.status === 'SNOOZED' ? '' : 'ml-auto '}h-2 w-2 shrink-0 rounded-full bg-blue-500`}
                                aria-label="Unread"
                              />
                            )}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hasMore && (
                  <div className="p-3">
                    <Button variant="outline" size="sm" className="w-full" onClick={() => setSize(size + 1)}>
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            </aside>
            <section className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
              {selectedId ? (
                <Thread
                  key={selectedId}
                  conversationId={selectedId}
                  currentUserId={user?.id}
                  connected={connected}
                  subscribe={subscribe}
                  onBack={() => setQuery({c: null})}
                  onChanged={refreshList}
                />
              ) : (
                <div className="m-auto">
                  <EmptyState icon={InboxIcon} title="Pick a conversation" description="Select a conversation to read it." />
                </div>
              )}
            </section>
          </div>
        )}
      </DashboardLayout>
    </>
  );
}

function Thread({
  conversationId,
  currentUserId,
  connected,
  subscribe,
  onBack,
  onChanged,
}: {
  conversationId: string;
  currentUserId: string | undefined;
  connected: boolean;
  subscribe: Subscribe;
  onBack: () => void;
  onChanged: () => void;
}) {
  const {data, mutate, error} = useSWR<{success: boolean; data: InboxConversation}>(`/conversations/${conversationId}`, {
    refreshInterval: connected ? 0 : THREAD_REFRESH_MS,
  });
  const [typing, setTyping] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const conversation = data?.data;
  const messageCount = conversation?.messages.length ?? 0;

  useEffect(() => {
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      if (event.type === 'ready') {
        void mutate();
        return;
      }
      if (event.conversationId !== conversationId) {
        return;
      }
      if (event.type === 'message') {
        setTyping(null);
        void mutate(
          current =>
            current && !current.data.messages.some(message => message.id === event.message.id)
              ? {...current, data: {...current.data, messages: [...current.data.messages, event.message]}}
              : current,
          {revalidate: event.message.authorType === 'CONTACT'},
        );
      } else if (event.type === 'conversation') {
        void mutate();
      } else if (event.type === 'read' && event.reader.type === 'CONTACT') {
        const readAt = event.reader.readAt;
        void mutate(current => (current ? {...current, data: {...current.data, contactLastReadAt: readAt}} : current), {
          revalidate: false,
        });
      } else if (event.type === 'typing') {
        const author = event.author;
        if (author.type === 'AGENT' && author.userId === currentUserId) {
          return;
        }
        setTyping(author.type === 'CONTACT' ? 'The visitor is typing…' : `${author.name} is typing…`);
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => setTyping(null), TYPING_VISIBLE_MS);
      }
    });
    return () => {
      off();
      clearTimeout(typingTimer);
    };
  }, [conversationId, currentUserId, subscribe, mutate]);

  useEffect(() => {
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      void network
        .fetch('POST', `/conversations/${conversationId}/read`)
        .then(onChanged)
        .catch(() => undefined);
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-marks read whenever a message arrives in the open thread
  }, [conversationId, messageCount]);

  useEffect(() => {
    bottom.current?.scrollIntoView({block: 'end'});
  }, [messageCount, typing]);

  const seenMessageId = (() => {
    if (!conversation?.contactLastReadAt) return null;
    const lastReply = [...conversation.messages]
      .reverse()
      .find(message => message.authorType === 'AGENT' && message.kind === 'COMMENT');
    return lastReply && new Date(conversation.contactLastReadAt) >= new Date(lastReply.createdAt) ? lastReply.id : null;
  })();

  if (error) {
    return <div className="m-auto text-sm text-neutral-500">Couldn’t load this conversation.</div>;
  }

  if (!conversation) {
    return (
      <div className="m-auto">
        <IconSpinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-200 px-4 py-3">
          <button className="rounded-md p-1 hover:bg-neutral-100 md:hidden" onClick={onBack} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <div className="truncate font-semibold text-neutral-900">{contactLabel(conversation.contact)}</div>
            <div className="text-xs text-neutral-500">
              {conversation.status === 'SNOOZED'
                ? conversation.snoozedUntil
                  ? `Snoozed until ${formatSnoozeDate(conversation.snoozedUntil)}`
                  : 'Snoozed until the visitor replies'
                : conversation.status === 'CLOSED'
                  ? 'Closed'
                  : `Started ${formatRelativeTime(conversation.createdAt)}`}
            </div>
          </div>
          <div className="w-full sm:ml-auto sm:w-auto">
            <ConversationActions
              conversation={conversation}
              currentUserId={currentUserId}
              onChanged={next => {
                void mutate({success: true, data: next}, {revalidate: false});
                onChanged();
              }}
            />
          </div>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-4 py-4">
          {conversation.messages.map(message => (
            <MessageRow
              key={message.id}
              message={message}
              seen={message.id === seenMessageId}
              currentUserId={currentUserId}
            />
          ))}
          {typing && (
            <div className="px-1 text-xs text-neutral-500" role="status">
              {typing}
            </div>
          )}
          <div ref={bottom} />
        </div>
        <Composer
          conversationId={conversationId}
          currentUserId={currentUserId}
          onSent={async () => {
            await mutate();
            onChanged();
          }}
        />
      </div>
      <aside className="hidden w-64 shrink-0 border-l border-neutral-200 p-4 xl:block">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Contact</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-neutral-500">Email</dt>
            <dd className="truncate text-neutral-900">{conversation.contact.email ?? 'Not shared yet'}</dd>
          </div>
          {conversation.contact.externalId && (
            <div>
              <dt className="text-neutral-500">External id</dt>
              <dd className="truncate text-neutral-900">{conversation.contact.externalId}</dd>
            </div>
          )}
        </dl>
        <Link
          href={`/contacts/${conversation.contact.id}`}
          className="mt-4 inline-block text-sm font-medium text-neutral-900 underline underline-offset-4"
        >
          Open contact
        </Link>
      </aside>
    </div>
  );
}

function MessageRow({
  message,
  seen,
  currentUserId,
}: {
  message: InboxMessage;
  seen: boolean;
  currentUserId: string | undefined;
}) {
  if (message.authorType === 'SYSTEM') {
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-neutral-500" role="note">
        <span className="h-px flex-1 bg-neutral-200" />
        <span className="text-center">
          {message.event ? describeSystemEvent(message.event, message.author, currentUserId) : message.body}
          <span className="text-neutral-400"> · {formatRelativeTime(message.createdAt)}</span>
        </span>
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    );
  }
  if (message.kind === 'NOTE') {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-950">
          <NoteBody body={message.body} mentions={message.mentions} currentUserId={currentUserId} />
        </div>
        <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-neutral-400">
          <StickyNote className="h-3 w-3 text-amber-600" />
          <span className="font-medium text-amber-700">Note</span>
          {` · ${message.author?.id === currentUserId ? 'You' : (message.author?.name ?? 'Team')} · `}
          {formatRelativeTime(message.createdAt)}
        </div>
      </div>
    );
  }
  const fromContact = message.authorType === 'CONTACT';
  return (
    <div className={`flex flex-col ${fromContact ? 'items-start' : 'items-end'}`}>
      <div
        className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
          fromContact ? 'border border-neutral-200 bg-white text-neutral-900' : 'bg-neutral-900 text-white'
        }`}
      >
        {message.body}
      </div>
      <div className="mt-1 px-1 text-[11px] text-neutral-400">
        {fromContact ? '' : `${message.author?.name ?? 'Team'} · `}
        {formatRelativeTime(message.createdAt)}
        {seen && ' · Seen'}
      </div>
    </div>
  );
}

function NoteBody({
  body,
  mentions,
  currentUserId,
}: {
  body: string;
  mentions: InboxMessage['mentions'];
  currentUserId: string | undefined;
}) {
  if (mentions.length === 0) {
    return <>{body}</>;
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const pattern = new RegExp(`(${names.map(mention => `@${escape(mention.name)}`).join('|')})`, 'g');
  return (
    <>
      {body.split(pattern).map((part, index) => {
        const mention = names.find(candidate => part === `@${candidate.name}`);
        if (!mention) return part;
        return (
          <span
            key={index}
            className={`rounded px-0.5 font-medium ${mention.id === currentUserId ? 'bg-amber-300 text-amber-950' : 'text-amber-800'}`}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}
