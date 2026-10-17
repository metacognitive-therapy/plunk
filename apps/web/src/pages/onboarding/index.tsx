import {motion} from 'framer-motion';
import {ArrowRight, Code2, Megaphone, Workflow} from 'lucide-react';
import {NextSeo} from 'next-seo';
import {useRouter} from 'next/router';

import {OnboardingLayout} from '../../components/onboarding/OnboardingLayout';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useOnboardingGate} from '../../lib/hooks/useOnboardingGate';
import {type OnboardingPath, useOnboardingPath} from '../../lib/hooks/useOnboardingPath';

interface PathOption {
  id: OnboardingPath;
  icon: React.ElementType;
  title: string;
  description: string;
  meta: string;
}

const paths: PathOption[] = [
  {
    id: 'developer',
    icon: Code2,
    title: 'Send transactional emails',
    description: 'Wire Plunk into your app for password resets, receipts, and notifications.',
    meta: '~1 minute',
  },
  {
    id: 'marketing',
    icon: Megaphone,
    title: 'Run email campaigns',
    description: 'Import contacts, draft campaigns, and broadcast to your audience.',
    meta: '~5 minutes',
  },
  {
    id: 'workflows',
    icon: Workflow,
    title: 'Automate with workflows',
    description: 'Trigger emails from events in your app — onboarding, retention, receipts.',
    meta: '~5 minutes',
  },
];

export default function OnboardingWelcome() {
  const router = useRouter();
  const {state} = useOnboardingGate();
  const {activeProject} = useActiveProject();
  const {setPath} = useOnboardingPath(activeProject?.id);

  if (state !== 'show') return null;

  const handleSelect = (id: PathOption['id']) => {
    setPath(id);
    void router.push(`/onboarding/${id}`);
  };

  return (
    <>
      <NextSeo title="Welcome to Plunk" />
      <OnboardingLayout step={1} maxWidthClass="max-w-5xl">
        <div className="flex flex-col gap-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-neutral-900">
              Welcome to Plunk.
            </h1>
            <p className="text-base text-neutral-600 max-w-lg leading-relaxed">
              Two minutes of setup and you&#39;ll be sending. How do you plan to use Plunk?
            </p>
          </header>

          <div className="grid gap-4 md:grid-cols-3">
            {paths.map((path, index) => {
              const Icon = path.icon;
              return (
                <motion.button
                  key={path.id}
                  type="button"
                  onClick={() => handleSelect(path.id)}
                  initial={{opacity: 0, y: 8}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.35, delay: 0.08 + index * 0.06, ease: [0.22, 1, 0.36, 1]}}
                  whileHover={{y: -2}}
                  whileTap={{scale: 0.995}}
                  className="group flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-6 text-left shadow-sm transition-colors hover:border-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-900">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="text-xs font-medium text-neutral-400 tabular-nums">{path.meta}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <h2 className="text-base font-semibold text-neutral-900">{path.title}</h2>
                    <p className="text-sm text-neutral-600 leading-relaxed">{path.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
                    <span>Start here</span>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </motion.button>
              );
            })}
          </div>

          <p className="text-xs text-neutral-500">
            Not sure? Pick the closest fit — you can do all three once you&#39;re set up.
          </p>
        </div>
      </OnboardingLayout>
    </>
  );
}
