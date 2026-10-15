import type {ConversationStatusValue, InboxContactProfile} from '@plunk/types';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {type ReactNode, useEffect} from 'react';
import useSWR from 'swr';

import {formatRelativeTime} from '../../lib/dateUtils';

const STATUS_LABELS: Record<ConversationStatusValue, string> = {OPEN: 'Open', SNOOZED: 'Snoozed', CLOSED: 'Closed'};
const MAX_DATA_FIELDS = 12;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

function Empty({children}: {children: ReactNode}) {
  return <p className="text-sm text-neutral-400">{children}</p>;
}

/** `version` changes whenever the conversation does, so new events and statuses show up. */
export function ContactPanel({conversationId, version}: {conversationId: string; version: string}) {
  const router = useRouter();
  const {data, error, mutate} = useSWR<{success: boolean; data: InboxContactProfile}>(
    `/conversations/${conversationId}/contact`,
    {
      revalidateOnFocus: false,
    },
  );
  const profile = data?.data;

  useEffect(() => {
    void mutate();
  }, [version, mutate]);

  if (error) {
    return <Empty>Couldn’t load this contact.</Empty>;
  }
  if (!profile) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map(row => (
          <div key={row} className="h-4 animate-pulse rounded bg-neutral-100" />
        ))}
      </div>
    );
  }

  const fields = Object.entries(profile.data ?? {})
    .filter(([, value]) => formatValue(value) !== '')
    .slice(0, MAX_DATA_FIELDS);

  return (
    <div className="space-y-6">
      <Section title="Contact">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-neutral-500">Email</dt>
            <dd className="truncate text-neutral-900">{profile.email ?? 'Not shared yet'}</dd>
          </div>
          {profile.externalId && (
            <div>
              <dt className="text-neutral-500">External id</dt>
              <dd className="truncate text-neutral-900">{profile.externalId}</dd>
            </div>
          )}
          <div>
            <dt className="text-neutral-500">Emails</dt>
            <dd className="text-neutral-900">{profile.subscribed ? 'Subscribed' : 'Not subscribed'}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">First seen</dt>
            <dd className="text-neutral-900">{formatRelativeTime(profile.createdAt)}</dd>
          </div>
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt className="truncate text-neutral-500">{key}</dt>
              <dd className="truncate text-neutral-900" title={formatValue(value)}>
                {formatValue(value)}
              </dd>
            </div>
          ))}
        </dl>
        <Link
          href={`/contacts/${profile.id}`}
          className="inline-block text-sm font-medium text-neutral-900 underline underline-offset-4"
        >
          Open contact
        </Link>
      </Section>

      <Section title="Tags">
        {profile.tags.length === 0 ? (
          <Empty>No tags</Empty>
        ) : (
          <div className="flex flex-wrap gap-1">
            {profile.tags.map(tag => (
              <span
                key={tag.id}
                className="max-w-full truncate rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Segments">
        {profile.segments.length === 0 ? (
          <Empty>In no segments</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {profile.segments.map(segment => (
              <li key={segment.id}>
                <Link href={`/segments/${segment.id}`} className="block truncate text-neutral-900 hover:underline">
                  {segment.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent events">
        {profile.events.length === 0 ? (
          <Empty>No events yet</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {profile.events.map(event => (
              <li key={event.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs text-neutral-900">{event.name}</span>
                <span className="shrink-0 text-xs text-neutral-500">{formatRelativeTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Other conversations">
        {profile.conversations.length === 0 ? (
          <Empty>None</Empty>
        ) : (
          <ul className="space-y-1">
            {profile.conversations.map(other => (
              <li key={other.id}>
                <Link
                  href={{pathname: '/inbox', query: {...router.query, view: 'all', c: other.id}}}
                  shallow
                  className="block rounded-md px-2 py-1.5 -mx-2 hover:bg-neutral-50"
                >
                  <span className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                    <span>{STATUS_LABELS[other.status]}</span>
                    <span>{formatRelativeTime(other.lastMessageAt)}</span>
                  </span>
                  <span className="block truncate text-sm text-neutral-900">
                    {other.lastMessage?.body ?? 'No messages'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
