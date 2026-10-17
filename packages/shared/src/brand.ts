/*
 * How a project presents itself to its contacts: the messenger, chat emails and push. The
 * dashboard and platform emails are always Plunk. A blank brand falls back to the project name.
 */
export interface Brand {
  name: string;
  logoUrl: string | null;
}

export function resolveBrand(
  project: {name: string; brandName?: string | null; brandLogoUrl?: string | null} | null,
): Brand {
  return {
    name: project?.brandName?.trim() || project?.name || 'Plunk',
    logoUrl: project?.brandLogoUrl || null,
  };
}
