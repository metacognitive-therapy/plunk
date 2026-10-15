import type {ContactConversations as ContactConversationsData, ConversationStatusValue} from '@plunk/types';
import {Card, CardContent, CardHeader, CardTitle} from '@plunk/ui';
import {MessageSquare} from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';

import {formatRelativeTime} from '../lib/dateUtils';

const STATUS_LABELS: Record<ConversationStatusValue, string> = {OPEN: 'Open', SNOOZED: 'Snoozed', CLOSED: 'Closed'};

export function ContactConversations({contactId}: {contactId: string}) {
  const {data} = useSWR<{success: boolean; data: ContactConversationsData}>(`/contacts/${contactId}/conversations`, {
    revalidateOnFocus: false,
  });
  const result = data?.data;
  if (!result || result.total === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1">
          {result.conversations.map(conversation => {
            const meta = (
              <span className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                <span className="inline-flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {STATUS_LABELS[conversation.status]}
                </span>
                <span>{formatRelativeTime(conversation.lastMessageAt)}</span>
              </span>
            );
            return (
              <li key={conversation.id}>
                {result.canOpen ? (
                  <Link
                    href={{pathname: '/inbox', query: {view: 'all', c: conversation.id}}}
                    className="-mx-2 block rounded-md px-2 py-1.5 hover:bg-neutral-50"
                  >
                    {meta}
                    <span className="block truncate text-sm text-neutral-900">
                      {conversation.lastMessage?.body ?? 'No messages'}
                    </span>
                  </Link>
                ) : (
                  <div className="py-1.5">{meta}</div>
                )}
              </li>
            );
          })}
        </ul>
        {result.total > result.conversations.length && (
          <p className="text-xs text-neutral-500">
            Showing the latest {result.conversations.length} of {result.total}.
          </p>
        )}
        {!result.canOpen && (
          <p className="text-xs text-neutral-500">Only support agents can read conversations. Ask one to open them.</p>
        )}
      </CardContent>
    </Card>
  );
}
