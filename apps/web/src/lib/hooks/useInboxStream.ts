import type {InboxStreamEvent} from '@plunk/types';

import {useEventStream} from './useEventStream';

/** Subscribes to the active project's inbox events while `enabled`. Returns whether it is connected. */
export function useInboxStream(
  projectId: string | undefined,
  enabled: boolean,
  onEvent: (event: InboxStreamEvent) => void,
): boolean {
  return useEventStream<InboxStreamEvent>(
    '/conversations/stream',
    projectId && enabled ? projectId : null,
    (): Record<string, string> => (projectId ? {'X-Project-Id': projectId} : {}),
    onEvent,
  );
}
