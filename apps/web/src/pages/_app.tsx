import '../styles/globals.css';
import type {AppProps} from 'next/app';
import {useRouter} from 'next/router';
import React, {useEffect} from 'react';
import {Toaster} from 'sonner';
import {SWRConfig} from 'swr';
import {DefaultSeo} from 'next-seo';
import {NuqsAdapter} from 'nuqs/adapters/next/pages';
import {Loader} from '@plunk/ui';
import {ActiveProjectProvider} from '../lib/contexts/ActiveProjectProvider';
import {formatUnread, useInboxUnread, useNotificationPrefs} from '../lib/hooks/useAgentNotifications';
import {CommandPalette} from '../components/CommandPalette';
import {AgentNotifier} from '../components/inbox/AgentNotifier';
import {useProjects} from '../lib/hooks/useProject';
import {useUser} from '../lib/hooks/useUser';
import {network} from '../lib/network';
import {addRecentPage, getFallbackLabel} from '../lib/recentPages';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import advancedFormat from 'dayjs/plugin/advancedFormat';

// Configure dayjs plugins globally
dayjs.extend(relativeTime);
dayjs.extend(advancedFormat);

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/auth/login',
  '/auth/signup',
  '/auth/reset-password',
  '/auth/verify-email',
  '/unsubscribe',
  '/subscribe',
  '/manage',
];

// Routes that don't require a project
const NO_PROJECT_ROUTES = ['/projects/create'];

function App({Component, pageProps}: AppProps) {
  return (
    <>
      <Component {...pageProps} />
    </>
  );
}

function AuthGuard({children}: {children: React.ReactNode}) {
  const {data: user, isLoading} = useUser();
  const router = useRouter();
  const isPublicRoute = PUBLIC_ROUTES.some(
    route => router.pathname === route || router.pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    // If not loading, no user, and trying to access a protected route, redirect to login
    if (!isLoading && !user && !isPublicRoute) {
      void router.push('/auth/login');
    }

    // If user is logged in and trying to access login/signup, redirect to home
    if (!isLoading && user && (router.pathname === '/auth/login' || router.pathname === '/auth/signup')) {
      void router.push('/');
    }
  }, [user, isLoading, router, isPublicRoute]);

  // Show loading state while checking authentication (only for protected routes)
  if (isLoading && !isPublicRoute) {
    return <Loader message="Authenticating…" />;
  }

  // Don't render protected content if redirecting
  if (!user && !isPublicRoute) {
    return null;
  }

  return <>{children}</>;
}

function ProjectGuard({children}: {children: React.ReactNode}) {
  const {data: projects, isLoading} = useProjects();
  const router = useRouter();
  const isNoProjectRoute = NO_PROJECT_ROUTES.includes(router.pathname);

  useEffect(() => {
    // If not loading, user has no projects, and not already on project creation page
    if (!isLoading && projects && projects.length === 0 && !isNoProjectRoute) {
      void router.push('/projects/create');
    }
  }, [projects, isLoading, router, isNoProjectRoute]);

  // Show loading state while checking projects (only for routes that need a project)
  if (isLoading && !isNoProjectRoute) {
    return <Loader message="Loading project…" />;
  }

  // Don't render protected content if redirecting
  if (!isLoading && projects && projects.length === 0 && !isNoProjectRoute) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Main app root component that houses all components
 * @param props Default nextjs props
 */
export default function WithProviders(props: AppProps) {
  return (
    <NuqsAdapter>
      <SWRConfig
        value={{
          fetcher: (url: string) => network.fetch('GET', url),
          shouldRetryOnError: false,
        }}
      >
        <ActiveProjectProvider>
          <Root {...props} />
        </ActiveProjectProvider>
      </SWRConfig>
    </NuqsAdapter>
  );
}

function TitleSeo({unread}: {unread: string | null}) {
  const prefix = unread ? `(${unread}) ` : '';
  return <DefaultSeo titleTemplate={`${prefix}%s | Plunk`} defaultTitle={`${prefix}Plunk | Email Platform Dashboard`} />;
}

function Root(props: AppProps) {
  const router = useRouter();
  const isPublicRoute = PUBLIC_ROUTES.some(
    route => router.pathname === route || router.pathname.startsWith(`${route}/`),
  );
  const {data: user} = useUser();
  const signedIn = !isPublicRoute && Boolean(user?.id);
  const {data: unread} = useInboxUnread(signedIn);
  const {data: prefs} = useNotificationPrefs(signedIn);
  const titleCount = signedIn && prefs?.data.inboxTitleCount ? formatUnread(unread?.data) : null;

  useEffect(() => {
    const handleRouteChange = () => {
      const pathname = window.location.pathname;

      // Pass 1: record immediately with a route-pattern label so detail pages
      // are always captured even before their data loads.
      const fallback = getFallbackLabel(pathname);
      if (fallback) {
        addRecentPage({label: fallback, href: pathname});
      }

      // Pass 2: after data loads, replace the label with the page's own title
      // (e.g. contact email set by NextSeo after the API response arrives).
      setTimeout(() => {
        const titleLabel = document.title.replace(/^\(\d+\+?\) /, '').split(' | ')[0]?.trim();
        if (titleLabel && titleLabel !== 'Plunk' && titleLabel !== fallback) {
          addRecentPage({label: titleLabel, href: pathname});
        }
      }, 800);
    };

    router.events.on('routeChangeComplete', handleRouteChange);
    return () => router.events.off('routeChangeComplete', handleRouteChange);
  }, [router.events]);

  return (
    <>
      <TitleSeo unread={titleCount} />
      <Toaster position={'top-right'} />

      <div>
        <AuthGuard>
          {isPublicRoute ? (
            <App {...props} />
          ) : (
            <ProjectGuard>
              <CommandPalette />
              <AgentNotifier />
              <App {...props} />
            </ProjectGuard>
          )}
        </AuthGuard>
      </div>
    </>
  );
}
