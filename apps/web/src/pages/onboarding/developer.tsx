import {Button, Skeleton} from '@plunk/ui';
import {motion} from 'framer-motion';
import {ArrowLeft, ArrowRight, KeyRound, Mail, ShieldCheck} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useEffect, useMemo} from 'react';

import {ApiKeyDisplay} from '../../components/ApiKeyDisplay';
import {CodeTabs, type CodeSnippet} from '../../components/onboarding/CodeTabs';
import {OnboardingLayout} from '../../components/onboarding/OnboardingLayout';
import {API_URI} from '../../lib/constants';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useOnboardingGate} from '../../lib/hooks/useOnboardingGate';
import {useOnboardingPath} from '../../lib/hooks/useOnboardingPath';

interface SetupStep {
  id: string;
  icon: React.ElementType;
  title: string;
  description: string;
  cta?: string;
  href?: string;
  required?: boolean;
}

const steps: SetupStep[] = [
  {
    id: 'domain',
    icon: ShieldCheck,
    title: 'Verify your sender domain',
    description: 'Sending requires a verified domain. Two DNS records and you\'re set.',
    cta: 'Verify domain',
    href: '/settings?tab=domains',
    required: true,
  },
  {
    id: 'key',
    icon: KeyRound,
    title: 'Copy your secret key',
    description: 'Add it to your server environment. Never expose it in client-side code.',
  },
  {
    id: 'send',
    icon: Mail,
    title: 'Send your first email',
    description: 'One API call. Pick your language and drop it into your app.',
  },
];

function buildSnippets(apiUrl: string, secret: string): CodeSnippet[] {
  const body = {
    to: 'you@example.com',
    subject: 'Hello from Plunk',
    body: '<p>Your first email is live.</p>',
    from: 'sender@yourdomain.com',
  };
  const curl = `curl -X POST ${apiUrl}/v1/send \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n    ')}'`;

  const node = `await fetch("${apiUrl}/v1/send", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${secret}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}),
});`;

  const python = `import requests

requests.post(
    "${apiUrl}/v1/send",
    headers={"Authorization": "Bearer ${secret}"},
    json=${JSON.stringify(body, null, 4).replace(/\n/g, '\n    ')},
)`;

  const php = `$ch = curl_init("${apiUrl}/v1/send");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer ${secret}",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode(${JSON.stringify(body, null, 4).replace(/\n/g, '\n        ')}),
]);
curl_exec($ch);`;

  return [
    {id: 'curl', label: 'cURL', code: curl},
    {id: 'node', label: 'Node.js', code: node},
    {id: 'python', label: 'Python', code: python},
    {id: 'php', label: 'PHP', code: php},
  ];
}

export default function OnboardingDeveloper() {
  const router = useRouter();
  const {activeProject} = useActiveProject();
  const {state} = useOnboardingGate();
  const {path, setPath} = useOnboardingPath(activeProject?.id);

  const snippets = useMemo(
    () => buildSnippets(API_URI, activeProject?.secret ?? 'sk_your_secret_key'),
    [activeProject?.secret],
  );

  useEffect(() => {
    if (activeProject && !path) setPath('developer');
  }, [activeProject, path, setPath]);

  if (state !== 'show') return null;

  const handleContinue = () => {
    void router.push('/');
  };

  const handleStepClick = (href: string) => {
    void router.push(href);
  };

  return (
    <>
      <NextSeo title="Send your first email" />
      <OnboardingLayout step={2}>
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-neutral-900">
              Send your first email.
            </h1>
            <p className="text-base text-neutral-600 max-w-xl leading-relaxed">
              Three steps to your first send. Start with your domain so emails actually reach the inbox.
            </p>
          </header>

          <div className="flex flex-col gap-3">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.id}
                  initial={{opacity: 0, y: 6}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.3, delay: 0.05 + index * 0.06, ease: [0.22, 1, 0.36, 1]}}
                  className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-4">
                      <div className="flex items-center gap-3">
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 text-xs font-semibold tabular-nums text-neutral-900">
                          {index + 1}
                        </span>
                        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-900">
                          <Icon className="h-5 w-5" />
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 pt-0.5">
                        <div className="flex items-center gap-2">
                          <h2 className="text-sm font-semibold text-neutral-900">{step.title}</h2>
                          {step.required && (
                            <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                              Required
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-neutral-600 leading-relaxed">{step.description}</p>
                      </div>
                    </div>
                    {step.cta && step.href && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="sm:self-center sm:flex-shrink-0"
                        onClick={() => handleStepClick(step.href!)}
                      >
                        {step.cta}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  {step.id === 'key' && (
                    <div className="border-t border-neutral-100 pt-4">
                      {activeProject ? (
                        <ApiKeyDisplay
                          label="Secret key"
                          value={activeProject.secret}
                          description="Keep this server-side. Treat it like a password."
                          isSecret
                        />
                      ) : (
                        <Skeleton className="h-16 rounded-lg" />
                      )}
                    </div>
                  )}

                  {step.id === 'send' && (
                    <div className="overflow-hidden rounded-lg border border-neutral-200">
                      <CodeTabs snippets={snippets} />
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>

          <div className="flex items-center justify-between pt-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
            <Button onClick={handleContinue}>
              Continue to dashboard
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </OnboardingLayout>
    </>
  );
}
