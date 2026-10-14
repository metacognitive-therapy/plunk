import {motion} from 'framer-motion';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {type CSSProperties, type ReactNode, useCallback} from 'react';

import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useBrand} from '../../lib/hooks/useBrand';
import {useOnboardingComplete} from '../../lib/hooks/useOnboardingComplete';
import {BrandMark} from '../BrandMark';

interface OnboardingLayoutProps {
  step: 1 | 2;
  totalSteps?: 1 | 2;
  /** Tailwind max-width class for the content column. Defaults to max-w-2xl. */
  maxWidthClass?: string;
  children: ReactNode;
}

const backgroundStyle: CSSProperties = {
  backgroundColor: '#fafafa',
  backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)',
  backgroundSize: '20px 20px',
};

export function OnboardingLayout({step, totalSteps = 2, maxWidthClass = 'max-w-2xl', children}: OnboardingLayoutProps) {
  const router = useRouter();
  const {activeProject} = useActiveProject();
  const brand = useBrand();
  const {markComplete} = useOnboardingComplete(activeProject?.id);

  const handleSkip = useCallback(() => {
    markComplete();
    void router.push('/');
  }, [markComplete, router]);

  const dots = Array.from({length: totalSteps}, (_, i) => i + 1);

  return (
    <div className="h-screen flex flex-col overflow-y-auto" style={backgroundStyle}>
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/">
          <BrandMark brand={brand} size="sm" />
        </Link>

        <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-neutral-500">
          <span className="tabular-nums">
            Step {step} of {totalSteps}
          </span>
          <div className="flex items-center gap-1.5 ml-1">
            {dots.map(d => (
              <span
                key={d}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  d <= step ? 'bg-neutral-900' : 'bg-neutral-300'
                }`}
              />
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={handleSkip}
          className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
        >
          Skip setup
        </button>
      </header>

      <main className="flex-1 flex justify-center px-4 pb-16 pt-4 sm:pb-24 sm:pt-8">
        <motion.div
          initial={{opacity: 0, y: 8}}
          animate={{opacity: 1, y: 0}}
          transition={{duration: 0.35, ease: [0.22, 1, 0.36, 1]}}
          className={`w-full ${maxWidthClass}`}
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
