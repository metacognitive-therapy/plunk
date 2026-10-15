import type {AgentStreamEvent} from '@plunk/types';
import {useRouter} from 'next/router';
import {useEffect} from 'react';
import {toast} from 'sonner';
import {useSWRConfig} from 'swr';

import {playChime, unlockChime} from '../../lib/chime';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {INBOX_UNREAD_KEY, useNotificationPrefs} from '../../lib/hooks/useAgentNotifications';
import {useEventStream} from '../../lib/hooks/useEventStream';
import {useUser} from '../../lib/hooks/useUser';
import {resyncPush} from '../../lib/push';

/**
 * The signed-in agent's notifications on any page and in any project: mentions as toasts, and
 * new visitor messages as a refreshed badge and a chime.
 */
export function AgentNotifier() {
  const router = useRouter();
  const {mutate} = useSWRConfig();
  const {data: user} = useUser();
  const {data: prefs} = useNotificationPrefs(Boolean(user?.id));
  const {activeProject, availableProjects, setActiveProject} = useActiveProject();

  useEffect(() => unlockChime(), []);

  useEffect(() => {
    if (user?.id) {
      void resyncPush();
    }
  }, [user?.id]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent<{type?: string; url?: string}>) => {
      if (event.data?.type === 'open' && event.data.url?.startsWith('/')) {
        void router.push(event.data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  useEventStream<AgentStreamEvent>(
    '/users/@me/stream',
    user?.id ?? null,
    () => ({}),
    event => {
      if (event.type === 'ready') {
        return;
      }
      const sameProject = activeProject?.id === event.projectId;
      const viewing =
        sameProject &&
        router.pathname === '/inbox' &&
        router.query.c === event.conversationId &&
        document.visibilityState === 'visible';

      if (event.type === 'visitor_message') {
        void mutate(INBOX_UNREAD_KEY);
        if (event.alert && !viewing && prefs?.data.inboxSound !== false) {
          playChime();
        }
        return;
      }
      if (viewing) {
        return;
      }
      const project = availableProjects.find(candidate => candidate.id === event.projectId);
      toast(`${event.author.name} mentioned you`, {
        description: sameProject || !project ? event.preview : `${project.name}: ${event.preview}`,
        duration: 10_000,
        action: {
          label: 'Open',
          onClick: () => {
            if (project && !sameProject) {
              setActiveProject(project);
            }
            void router.push({pathname: '/inbox', query: {view: 'all', c: event.conversationId}});
          },
        },
      });
    },
  );

  return null;
}
