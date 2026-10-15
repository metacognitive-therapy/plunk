import useSWR from 'swr';

import {useActiveProject} from '../contexts/ActiveProjectProvider';
import {useUser} from './useUser';

interface MemberRow {
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  supportAgent: boolean;
}

/** Whether the signed-in user may use the support inbox on the active project. */
export function useSupportAccess(): boolean {
  const {activeProject} = useActiveProject();
  const {data: user} = useUser();
  const {data} = useSWR<{success: boolean; data: MemberRow[]}>(
    activeProject?.id ? `/projects/${activeProject.id}/members` : null,
    {revalidateOnFocus: false},
  );

  const membership = data?.data.find(member => member.userId === user?.id);
  return membership ? membership.role === 'OWNER' || membership.supportAgent : false;
}
