import {Button, Textarea} from '@plunk/ui';
import type {ConversationSchemas} from '@plunk/shared';
import type {InboxAgent, InboxMessage} from '@plunk/types';
import {Send, StickyNote} from 'lucide-react';
import {useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../../lib/network';

const TYPING_SEND_INTERVAL_MS = 2500;
const MAX_SUGGESTIONS = 6;

type Mode = 'reply' | 'note';

const MENTION_QUERY = /(?:^|\s)@([^\s@]{0,30})$/;

export function Composer({
  conversationId,
  currentUserId,
  onSent,
}: {
  conversationId: string;
  currentUserId: string | undefined;
  onSent: () => Promise<unknown> | void;
}) {
  const {data: agents} = useSWR<{success: boolean; data: InboxAgent[]}>('/conversations/agents');
  const [mode, setMode] = useState<Mode>('reply');
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<InboxAgent[]>([]);
  const [sending, setSending] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const lastTypingSent = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const suggestions =
    query === null
      ? []
      : (agents?.data ?? [])
          .filter(agent => agent.id !== currentUserId && agent.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, MAX_SUGGESTIONS);
  const picking = mode === 'note' && suggestions.length > 0;

  const updateQuery = (value: string, caret: number) => {
    const match = mode === 'note' ? MENTION_QUERY.exec(value.slice(0, caret)) : null;
    setQuery(match ? match[1]! : null);
    setHighlight(0);
  };

  const onChange = (value: string, caret: number) => {
    setDraft(value);
    updateQuery(value, caret);
    /* A note is private, so typing one must not show the visitor that someone is typing. */
    const now = Date.now();
    if (mode === 'reply' && value.trim() && now - lastTypingSent.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSent.current = now;
      void network.fetch('POST', `/conversations/${conversationId}/typing`).catch(() => undefined);
    }
  };

  const pick = (agent: InboxAgent) => {
    const element = textarea.current;
    const caret = element?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@[^\s@]*$/, `@${agent.name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentions(current => (current.some(existing => existing.id === agent.id) ? current : [...current, agent]));
    setQuery(null);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setQuery(null);
    textarea.current?.focus();
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (mode === 'note') {
        /* Only mentions still present in the text count, so deleting "@Kari" un-mentions Kari. */
        const mentionedUserIds = mentions.filter(agent => body.includes(`@${agent.name}`)).map(agent => agent.id);
        await network.fetch<{data: InboxMessage}, typeof ConversationSchemas.note>(
          'POST',
          `/conversations/${conversationId}/notes`,
          {body, mentionedUserIds},
        );
      } else {
        await network.fetch<{data: InboxMessage}, typeof ConversationSchemas.reply>(
          'POST',
          `/conversations/${conversationId}/messages`,
          {body},
        );
      }
      setDraft('');
      setMentions([]);
      await onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t send. Try again.');
    } finally {
      setSending(false);
    }
  };

  const note = mode === 'note';

  return (
    <form
      className={`border-t p-3 transition-colors ${note ? 'border-amber-200 bg-amber-50' : 'border-neutral-200 bg-white'}`}
      onSubmit={event => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="mb-2 flex gap-0.5" role="tablist" aria-label="Message type">
        {(['reply', 'note'] as const).map(option => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={mode === option}
            onClick={() => switchMode(option)}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              mode === option
                ? option === 'note'
                  ? 'bg-amber-200 text-amber-900'
                  : 'bg-neutral-900 text-white'
                : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {option === 'reply' ? 'Reply' : 'Note'}
          </button>
        ))}
      </div>
      <div className="relative">
        {picking && (
          <ul
            role="listbox"
            aria-label="Mention a teammate"
            className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
          >
            {suggestions.map((agent, index) => (
              <li key={agent.id} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  onMouseDown={event => {
                    event.preventDefault();
                    pick(agent);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  className={`flex w-full flex-col px-3 py-1.5 text-left text-sm ${
                    index === highlight ? 'bg-neutral-100' : ''
                  }`}
                >
                  <span className="truncate text-neutral-900">{agent.name}</span>
                  <span className="truncate text-xs text-neutral-500">{agent.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          ref={textarea}
          value={draft}
          onChange={event => onChange(event.target.value, event.target.selectionStart)}
          onSelect={event => updateQuery(draft, event.currentTarget.selectionStart)}
          onBlur={() => setQuery(null)}
          onKeyDown={event => {
            if (picking) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHighlight(current => (current + step + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pick(suggestions[Math.min(highlight, suggestions.length - 1)]!);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery(null);
                return;
              }
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={note ? 'Add a note only your team can see. Type @ to mention a teammate.' : 'Reply to the visitor…'}
          rows={3}
          maxLength={5000}
          aria-label={note ? 'Note' : 'Reply'}
          className={note ? 'border-amber-300 bg-white focus-visible:ring-amber-400' : undefined}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-neutral-400">
          {note ? 'Only your team sees notes · ⌘ Enter to add' : '⌘ Enter to send'}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={sending || !draft.trim()}
          className={note ? 'bg-amber-600 text-white hover:bg-amber-700' : undefined}
        >
          {note ? <StickyNote className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}
          {note ? 'Add note' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
