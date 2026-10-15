import {MessengerSettingsSchemas, normalizeOrigin} from '@plunk/shared';
import type {MessengerSettingsData} from '@plunk/types';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch, Textarea} from '@plunk/ui';
import {ExternalLink} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {API_URI} from '../lib/constants';
import {network} from '../lib/network';

interface MessengerSettingsProps {
  canEdit: boolean;
}

export function MessengerSettings({canEdit}: MessengerSettingsProps) {
  const {activeProject} = useActiveProject();
  const {data, mutate} = useSWR<{success: boolean; data: MessengerSettingsData}>(
    activeProject?.id ? `/projects/${activeProject.id}/messenger` : null,
    {revalidateOnFocus: false},
  );
  const [enabled, setEnabled] = useState(false);
  const [originsText, setOriginsText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data?.data) {
      setEnabled(data.data.enabled);
      setOriginsText(data.data.allowedOrigins.join('\n'));
    }
  }, [data]);

  if (!activeProject) return null;

  const lines = originsText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const invalid = lines.filter(line => !normalizeOrigin(line));
  const standaloneUrl = `${API_URI}/widget/?key=${encodeURIComponent(activeProject.public)}`;

  const save = async () => {
    if (invalid.length > 0) {
      toast.error(`Not a valid origin: ${invalid[0]}`);
      return;
    }
    setSaving(true);
    try {
      await network.fetch<void, typeof MessengerSettingsSchemas.update>('PATCH', `/projects/${activeProject.id}/messenger`, {
        enabled,
        allowedOrigins: lines,
      });
      await mutate();
      toast.success('Messenger settings saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the messenger settings. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messenger</CardTitle>
        <CardDescription>
          Let visitors on your websites chat with your team. Conversations arrive in the Inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="messenger-enabled">Enable the messenger</Label>
            <p className="text-sm text-neutral-500">It only runs on the websites listed below.</p>
          </div>
          <Switch id="messenger-enabled" checked={enabled} disabled={!canEdit} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="messenger-origins">Allowed websites</Label>
          <Textarea
            id="messenger-origins"
            value={originsText}
            disabled={!canEdit}
            onChange={event => setOriginsText(event.target.value)}
            placeholder={'https://www.example.com\nhttps://example.com'}
            rows={4}
            className="font-mono text-sm"
          />
          <p className="text-sm text-neutral-500">
            One origin per line, including the scheme. Any other website is refused.
          </p>
          {invalid.length > 0 && <p className="text-sm text-red-600">Not a valid origin: {invalid.join(', ')}</p>}
        </div>

        <div className="space-y-1.5">
          <Label>Standalone messenger</Label>
          <a
            href={standaloneUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 break-all text-sm text-neutral-900 underline underline-offset-4"
          >
            {standaloneUrl}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        </div>

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
