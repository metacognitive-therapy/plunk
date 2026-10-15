import type {AgentStreamEvent} from '@plunk/types';
import {useRouter} from 'next/router';
import {toast} from 'sonner';

import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useEventStream} from '../../lib/hooks/useEventStream';
import {useUser} from '../../lib/hooks/useUser';

/** Tells the signed-in agent, on any page and in any project, that someone mentioned them in a note. */
export function MentionNotifier() {
  const router = useRouter();
  const {data: user} = useUser();
  const {activeProject, availableProjects, setActiveProject} = useActiveProject();

  useEventStream<AgentStreamEvent>(
    '/users/@me/stream',
    user?.id ?? null,
    () => ({}),
    event => {
      if (event.type !== 'mention') {
        return;
      }
      const sameProject = activeProject?.id === event.projectId;
      if (sameProject && router.pathname === '/inbox' && router.query.c === event.conversationId) {
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
