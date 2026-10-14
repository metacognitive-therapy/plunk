import {type Brand, resolveBrand} from '@plunk/shared';

import {useActiveProject} from '../contexts/ActiveProjectProvider';

export function useBrand(): Brand {
  const {activeProject} = useActiveProject();
  return resolveBrand(activeProject);
}
