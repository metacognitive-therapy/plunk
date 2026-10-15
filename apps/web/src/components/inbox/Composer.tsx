import {Button, Textarea} from '@plunk/ui';
import {CHAT_ATTACHMENT_ACCEPT, CHAT_ATTACHMENT_MAX_BYTES, type ConversationSchemas} from '@plunk/shared';
import type {InboxAgent, InboxMessage, SavedReply} from '@plunk/types';
import {Loader2, MessageSquareText, Paperclip, Send, StickyNote} from 'lucide-react';
import Link from 'next/link';
import {useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../../lib/network';

const TYPING_SEND_INTERVAL_MS = 2500;
const MAX_SUGGESTIONS = 6;

type Mode = 'reply' | 'note';

/* `start` is where the text the pick replaces begins: the trigger character, or the caret when the
picker was opened from the button. */
interface Trigger {
  kind: 'mention' | 'saved';
  query: string;
  start: number;
}

interface Suggestion {
  id: string;
  label: string;
  detail: string;
}

const TRIGGERS = [
  {kind: 'mention', pattern: /(?:^|\s)(@)([^\s@]{0,30})$/},
  {kind: 'saved', pattern: /(?:^|\s)(#)([^\s#]{0,30})$/},
] as const;

function findTrigger(text: string, mode: Mode): Trigger | null {
  for (const {kind, pattern} of TRIGGERS) {
    if (kind === 'mention' && mode !== 'note') continue;
    const match = pattern.exec(text);
    if (match) {
      return {kind, query: match[2]!, start: text.length - match[2]!.length - 1};
    }
  }
  return null;
}

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
  const {data: savedReplies} = useSWR<{success: boolean; data: SavedReply[]}>('/conversations/saved-replies');
  const [mode, setMode] = useState<Mode>('reply');
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<InboxAgent[]>([]);
  const [sending, setSending] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  const lastTypingSent = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const needle = trigger?.query.toLowerCase() ?? '';
  const suggestions: Suggestion[] = !trigger
    ? []
    : trigger.kind === 'mention'
      ? (agents?.data ?? [])
          .filter(agent => agent.id !== currentUserId && agent.name.toLowerCase().includes(needle))
          .slice(0, MAX_SUGGESTIONS)
          .map(agent => ({id: agent.id, label: agent.name, detail: agent.email}))
      : (savedReplies?.data ?? [])
          .filter(reply => reply.title.toLowerCase().includes(needle))
          .slice(0, MAX_SUGGESTIONS)
          .map(reply => ({id: reply.id, label: reply.title, detail: reply.body.replace(/\s+/g, ' ')}));
  const showPicker = trigger !== null && (suggestions.length > 0 || trigger.kind === 'saved');

  const updateTrigger = (value: string, caret: number) => {
    setTrigger(findTrigger(value.slice(0, caret), mode));
    setHighlight(0);
  };

  const onChange = (value: string, caret: number) => {
    setDraft(value);
    updateTrigger(value, caret);
    /* A note is private, so typing one must not show the visitor that someone is typing. */
    const now = Date.now();
    if (mode === 'reply' && value.trim() && now - lastTypingSent.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSent.current = now;
      void network.fetch('POST', `/conversations/${conversationId}/typing`).catch(() => undefined);
    }
  };

  const insert = (start: number, text: string) => {
    const element = textarea.current;
    const caret = element?.selectionStart ?? draft.length;
    const before = draft.slice(0, start) + text;
    setDraft(before + draft.slice(Math.max(caret, start)));
    setTrigger(null);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  };

  const pick = async (suggestion: Suggestion) => {
    if (!trigger) return;
    const {kind, start} = trigger;
    if (kind === 'mention') {
      const agent = agents?.data.find(candidate => candidate.id === suggestion.id);
      if (!agent) return;
      setMentions(current => (current.some(existing => existing.id === agent.id) ? current : [...current, agent]));
      insert(start, `@${agent.name} `);
      return;
    }
    setTrigger(null);
    try {
      const rendered = await network.fetch<{data: {body: string}}>(
        'GET',
        `/conversations/${conversationId}/saved-replies/${suggestion.id}`,
      );
      insert(start, rendered.data.body);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t insert the saved reply.');
    }
  };

  const openedFromButton = (caret: number) =>
    trigger?.kind === 'saved' && trigger.query === '' && trigger.start === caret;

  const openSavedReplies = () => {
    const caret = textarea.current?.selectionStart ?? draft.length;
    setTrigger({kind: 'saved', query: '', start: caret});
    setHighlight(0);
    textarea.current?.focus();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setTrigger(null);
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

  /* The draft is sent as the file's caption, so the agent can say what they are sharing. */
  const attach = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      toast.error('Files can be up to 10 MB.');
      return;
    }
    const form = new FormData();
    form.append('body', draft.trim());
    form.append('file', file);
    setUploading(true);
    try {
      await network.upload<{data: InboxMessage}>('POST', `/conversations/${conversationId}/attachments`, form);
      setDraft('');
      await onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t send the file. Try again.');
    } finally {
      setUploading(false);
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
      <div className="mb-2 flex items-center gap-0.5" role="tablist" aria-label="Message type">
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
        {!note && (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={CHAT_ATTACHMENT_ACCEPT}
              onChange={event => {
                void attach(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
              {uploading ? 'Sending…' : 'Attach'}
            </button>
          </>
        )}
        <button
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={openSavedReplies}
          className={`${note ? 'ml-auto ' : ''}flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100`}
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          Saved replies
        </button>
      </div>
      <div className="relative">
        {showPicker && (
          <div
            onMouseDown={event => event.preventDefault()}
            className="absolute bottom-full left-0 z-10 mb-1 w-80 max-w-full overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
          >
            {suggestions.length > 0 ? (
              <ul role="listbox" aria-label={trigger.kind === 'mention' ? 'Mention a teammate' : 'Insert a saved reply'}>
                {suggestions.map((suggestion, index) => (
                  <li key={suggestion.id} role="option" aria-selected={index === highlight}>
                    <button
                      type="button"
                      onMouseDown={event => {
                        event.preventDefault();
                        void pick(suggestion);
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={`flex w-full flex-col px-3 py-1.5 text-left text-sm ${
                        index === highlight ? 'bg-neutral-100' : ''
                      }`}
                    >
                      <span className="truncate text-neutral-900">{suggestion.label}</span>
                      <span className="truncate text-xs text-neutral-500">{suggestion.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-xs text-neutral-500">
                {savedReplies?.data.length ? 'No saved reply matches. ' : 'No saved replies yet. '}
                <Link href="/settings?tab=messenger" className="font-medium text-neutral-900 underline underline-offset-2">
                  Manage saved replies
                </Link>
              </p>
            )}
          </div>
        )}
        <Textarea
          ref={textarea}
          value={draft}
          onChange={event => onChange(event.target.value, event.target.selectionStart)}
          onSelect={event => {
            if (!openedFromButton(event.currentTarget.selectionStart)) {
              updateTrigger(draft, event.currentTarget.selectionStart);
            }
          }}
          onBlur={() => setTrigger(null)}
          onKeyDown={event => {
            if (showPicker) {
              if (event.key === 'Escape') {
                event.preventDefault();
                setTrigger(null);
                return;
              }
              if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHighlight(current => (current + step + suggestions.length) % suggestions.length);
                return;
              }
              if (suggestions.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
                event.preventDefault();
                void pick(suggestions[Math.min(highlight, suggestions.length - 1)]!);
                return;
              }
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            note
              ? 'Add a note only your team can see. Type @ to mention a teammate.'
              : 'Reply to the visitor… Type # for a saved reply.'
          }
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
