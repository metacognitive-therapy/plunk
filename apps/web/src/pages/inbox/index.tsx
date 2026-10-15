import {Badge, Button, EmptyState, IconSpinner, Textarea} from '@plunk/ui';
import {CONVERSATION_VIEWS, type ConversationSchemas, type ConversationView} from '@plunk/shared';
import type {InboxConversation, InboxConversationSummary, InboxMessage, InboxPage} from '@plunk/types';
import {ArrowLeft, Inbox as InboxIcon, MessageSquare, Send} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import {DashboardLayout} from '../../components/DashboardLayout';
import {formatRelativeTime} from '../../lib/dateUtils';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useSupportAccess} from '../../lib/hooks/useSupportAccess';
import {network} from '../../lib/network';

const LIST_REFRESH_MS = 10_000;
const THREAD_REFRESH_MS = 5_000;
const PAGE_SIZE = 30;

const VIEW_LABELS: Record<ConversationView, string> = {
  unassigned: 'Unassigned',
  mine: 'Mine',
  all: 'All open',
  closed: 'Closed',
};

function contactLabel(contact: InboxConversationSummary['contact']): string {
  const data = contact.data ?? {};
  const name = [data.firstName, data.lastName].filter(part => typeof part === 'string' && part).join(' ');
  return name || contact.email || contact.externalId || 'Anonymous visitor';
}

export default function InboxPageView() {
  const router = useRouter();
  const {activeProject} = useActiveProject();
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

  const {data, size, setSize, mutate, isLoading, error} = useSWRInfinite<{success: boolean; data: InboxPage}>(
    (index, previous) => {
      if (!activeProject?.id || !hasAccess) return null;
      if (previous && !previous.data.nextCursor) return null;
      const cursor = previous?.data.nextCursor ? `&cursor=${encodeURIComponent(previous.data.nextCursor)}` : '';
      return `/conversations?view=${view}&limit=${PAGE_SIZE}${cursor}`;
    },
    {refreshInterval: LIST_REFRESH_MS, revalidateFirstPage: true},
  );

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
                <div className="mt-3 flex flex-wrap gap-1" role="tablist">
                  {CONVERSATION_VIEWS.map(option => (
                    <button
                      key={option}
                      role="tab"
                      aria-selected={view === option}
                      onClick={() => setQuery({view: option, c: null})}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        view === option ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
                      }`}
                    >
                      {VIEW_LABELS[option]}
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
                            {conversation.unread && (
                              <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-label="Unread" />
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
                  onBack={() => setQuery({c: null})}
                  onChanged={() => void mutate()}
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
  onBack,
  onChanged,
}: {
  conversationId: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const {data, mutate, error} = useSWR<{success: boolean; data: InboxConversation}>(`/conversations/${conversationId}`, {
    refreshInterval: THREAD_REFRESH_MS,
  });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const conversation = data?.data;
  const messageCount = conversation?.messages.length ?? 0;

  useEffect(() => {
    void network
      .fetch('POST', `/conversations/${conversationId}/read`)
      .then(onChanged)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-marks read whenever a message arrives in the open thread
  }, [conversationId, messageCount]);

  useEffect(() => {
    bottom.current?.scrollIntoView({block: 'end'});
  }, [messageCount]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await network.fetch<{data: InboxMessage}, typeof ConversationSchemas.reply>(
        'POST',
        `/conversations/${conversationId}/messages`,
        {body},
      );
      setDraft('');
      await mutate();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t send the reply. Try again.');
    } finally {
      setSending(false);
    }
  };

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
        <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-3">
          <button className="rounded-md p-1 hover:bg-neutral-100 md:hidden" onClick={onBack} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <div className="truncate font-semibold text-neutral-900">{contactLabel(conversation.contact)}</div>
            <div className="text-xs text-neutral-500">Started {formatRelativeTime(conversation.createdAt)}</div>
          </div>
          <Badge variant="outline" className="ml-auto capitalize">
            {conversation.status.toLowerCase()}
          </Badge>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-4 py-4">
          {conversation.messages.map(message => (
            <MessageRow key={message.id} message={message} />
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="border-t border-neutral-200 bg-white p-3"
          onSubmit={event => {
            event.preventDefault();
            void send();
          }}
        >
          <Textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Reply to the visitor…"
            rows={3}
            maxLength={5000}
            aria-label="Reply"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-neutral-400">⌘ Enter to send</span>
            <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
              <Send className="mr-2 h-4 w-4" />
              Send
            </Button>
          </div>
        </form>
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

function MessageRow({message}: {message: InboxMessage}) {
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
      </div>
    </div>
  );
}
