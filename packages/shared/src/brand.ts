/*
 * One deployment serves several organizations, each as its own project, so the brand lives on
 * the project. Anything rendered before a project is known uses the neutral brand, which
 * deliberately names neither organization.
 */
export const NEUTRAL_BRAND_NAME = 'Messaging';

export interface Brand {
  name: string;
  logoUrl: string | null;
}

export const NEUTRAL_BRAND: Brand = {name: NEUTRAL_BRAND_NAME, logoUrl: null};

// A blank brand falls back to neutral, not to the project name: project names are internal labels.
export function resolveBrand(project?: {brandName?: string | null; brandLogoUrl?: string | null} | null): Brand {
  return {
    name: project?.brandName?.trim() || NEUTRAL_BRAND_NAME,
    logoUrl: project?.brandLogoUrl || null,
  };
}
