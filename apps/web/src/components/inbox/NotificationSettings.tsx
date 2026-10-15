import type {NotificationSchemas} from '@plunk/shared';
import type {AgentNotificationPrefs} from '@plunk/types';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch} from '@plunk/ui';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';

import {useNotificationPrefs} from '../../lib/hooks/useAgentNotifications';
import {useConfig} from '../../lib/hooks/useConfig';
import {network} from '../../lib/network';
import {disablePush, enablePush, type PushState, pushState} from '../../lib/push';

const TOGGLES: {key: keyof AgentNotificationPrefs; label: string; hint: string}[] = [
  {key: 'inboxBadge', label: 'Unread badge', hint: 'A count on the Inbox in the menu.'},
  {key: 'inboxTitleCount', label: 'Count in the tab title', hint: 'So you see new messages from another tab.'},
  {key: 'inboxSound', label: 'Sound', hint: 'A short chime when a visitor writes to you, or to the team while unassigned.'},
  {
    key: 'pushPreview',
    label: 'Show message text in push notifications',
    hint: 'Turn off to show only that a message arrived, for example on a shared screen or lock screen.',
  },
];

function needsHomeScreenInstall(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  return ios && !window.matchMedia('(display-mode: standalone)').matches;
}

export function NotificationSettings() {
  const {data, mutate} = useNotificationPrefs();
  const {data: config} = useConfig();
  const publicKey = config?.features.webPush?.publicKey ?? null;
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [installHint, setInstallHint] = useState(false);

  useEffect(() => {
    void pushState().then(setPush);
    setInstallHint(needsHomeScreenInstall());
  }, []);

  const prefs = data?.data;

  const toggle = async (key: keyof AgentNotificationPrefs, value: boolean) => {
    if (!prefs) return;
    void mutate({success: true, data: {...prefs, [key]: value}}, {revalidate: false});
    try {
      const updated = await network.fetch<{success: boolean; data: AgentNotificationPrefs}, typeof NotificationSchemas.prefs>(
        'PATCH',
        '/users/@me/notifications',
        {[key]: value},
      );
      void mutate(updated, {revalidate: false});
    } catch (error) {
      void mutate();
      toast.error(error instanceof Error ? error.message : 'Couldn’t save. Try again.');
    }
  };

  const turnOn = async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      await enablePush(publicKey);
      toast.success('Notifications are on for this device');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t turn on notifications.');
    } finally {
      setPush(await pushState());
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await disablePush();
    } finally {
      setPush(await pushState());
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const result = await network.fetch<{success: boolean; data: {sent: number}}>('POST', '/users/@me/push-subscriptions/test');
      if (result.data.sent === 0) {
        toast.error('No device received it. Turn notifications off and on again.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t send a test.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your notifications</CardTitle>
        <CardDescription>
          For new live chat messages, in every project you answer. Only you see these settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-neutral-200 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-neutral-900">Notifications on this device</p>
            <p className="text-sm text-neutral-500">
              Get a notification when the dashboard is closed. Turn it on separately on each computer and phone.
            </p>
          </div>
          {!publicKey ? (
            <p className="text-sm text-neutral-500">Push notifications are not set up on this server.</p>
          ) : push === 'unsupported' ? (
            <p className="text-sm text-neutral-500">
              {installHint
                ? 'On iPhone and iPad, first add the dashboard to your Home Screen: tap Share, then Add to Home Screen. Open it from there and turn notifications on.'
                : 'This browser doesn’t support notifications.'}
            </p>
          ) : push === 'denied' ? (
            <p className="text-sm text-neutral-500">
              Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.
            </p>
          ) : push === 'on' ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={sendTest} disabled={busy}>
                Send a test
              </Button>
              <Button variant="ghost" onClick={turnOff} disabled={busy}>
                Turn off on this device
              </Button>
            </div>
          ) : (
            <Button onClick={turnOn} disabled={busy || push === null}>
              {busy ? 'Turning on…' : 'Turn on notifications'}
            </Button>
          )}
        </div>

        {TOGGLES.map(item => (
          <div key={item.key} className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor={`notify-${item.key}`}>{item.label}</Label>
              <p className="text-sm text-neutral-500">{item.hint}</p>
            </div>
            <Switch
              id={`notify-${item.key}`}
              checked={prefs?.[item.key] ?? true}
              disabled={!prefs}
              onCheckedChange={value => void toggle(item.key, value)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
