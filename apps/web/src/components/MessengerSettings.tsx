import {
  MESSENGER_DEFAULT_ACCENT,
  MESSENGER_EMAIL_DELAY_DEFAULT_MINUTES,
  MESSENGER_EMAIL_DELAY_MAX_MINUTES,
  MESSENGER_GREETING_MAX_LENGTH,
  MESSENGER_RETENTION_DEFAULT_MONTHS,
  MESSENGER_RETENTION_MAX_MONTHS,
  MESSENGER_DEFAULT_TIMEZONE,
  MESSENGER_TEAM_MAX,
  type MessengerSettingsSchemas,
  type ProfileSchemas,
  isSlackWebhookUrl,
  normalizeOrigin,
} from '@plunk/shared';
import type {
  MemberWithEmail,
  MessengerIdentitySecret,
  MessengerLauncherPositionValue,
  MessengerReplyTimeValue,
  MessengerSettingsData,
  OfficeHoursDay,
} from '@plunk/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StickySaveBar,
  Switch,
  Textarea,
} from '@plunk/ui';
import {Check, Copy, ExternalLink} from 'lucide-react';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {API_URI} from '../lib/constants';
import {useConfig} from '../lib/hooks/useConfig';
import {useDomains} from '../lib/hooks/useDomains';
import {useUser} from '../lib/hooks/useUser';
import {network} from '../lib/network';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const REPLY_TIMES: {value: MessengerReplyTimeValue; label: string}[] = [
  {value: 'FEW_MINUTES', label: 'In a few minutes'},
  {value: 'FEW_HOURS', label: 'In a few hours'},
  {value: 'ONE_DAY', label: 'Within a day'},
];

interface HoursRow {
  open: boolean;
  start: string;
  end: string;
}

function toClock(minutes: number): string {
  const value = minutes % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/* A closing time of 00:00 means midnight at the end of the day. */
function fromClock(value: string, closing: boolean): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return closing && minutes === 0 ? 1440 : minutes;
}

function toRows(days: OfficeHoursDay[]): HoursRow[] {
  return WEEKDAYS.map((_, index) => {
    const day = days.find(candidate => candidate.day === index + 1);
    return day
      ? {open: true, start: toClock(day.start), end: toClock(day.end)}
      : {open: false, start: '09:00', end: '17:00'};
  });
}

function toDays(rows: HoursRow[]): OfficeHoursDay[] | null {
  const days: OfficeHoursDay[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.open) continue;
    const start = fromClock(row.start, false);
    const end = fromClock(row.end, true);
    if (start === null || end === null || end <= start) return null;
    days.push({day: index + 1, start, end});
  }
  return days;
}

function hoursKey(days: OfficeHoursDay[] | null): string {
  return days ? days.map(day => `${day.day}:${day.start}-${day.end}`).join(',') : 'invalid';
}

function timeZones(current: string): string[] {
  const supported =
    (Intl as unknown as {supportedValuesOf?: (key: string) => string[]}).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([MESSENGER_DEFAULT_TIMEZONE, current, ...supported])].sort();
}

interface MessengerSettingsProps {
  canEdit: boolean;
}

export function MessengerSettings({canEdit}: MessengerSettingsProps) {
  const {activeProject} = useActiveProject();
  const {data, mutate} = useSWR<{success: boolean; data: MessengerSettingsData}>(
    activeProject?.id ? `/projects/${activeProject.id}/messenger` : null,
    {revalidateOnFocus: false},
  );
  const {data: members, mutate: mutateMembers} = useSWR<{success: boolean; data: MemberWithEmail[]}>(
    activeProject?.id ? `/projects/${activeProject.id}/members` : null,
    {revalidateOnFocus: false},
  );
  const [enabled, setEnabled] = useState(false);
  const [originsText, setOriginsText] = useState('');
  const [accentColor, setAccentColor] = useState(MESSENGER_DEFAULT_ACCENT);
  const [launcherPosition, setLauncherPosition] = useState<MessengerLauncherPositionValue>('RIGHT');
  const [greeting, setGreeting] = useState('');
  const [teamUserIds, setTeamUserIds] = useState<string[]>([]);
  const [replyDomain, setReplyDomain] = useState('');
  const [replyFromEmail, setReplyFromEmail] = useState('');
  const [emailDelay, setEmailDelay] = useState(String(MESSENGER_EMAIL_DELAY_DEFAULT_MINUTES));
  const [replyTime, setReplyTime] = useState<MessengerReplyTimeValue>('FEW_HOURS');
  const [retention, setRetention] = useState(String(MESSENGER_RETENTION_DEFAULT_MONTHS));
  const [officeHoursEnabled, setOfficeHoursEnabled] = useState(false);
  const [timezone, setTimezone] = useState(MESSENGER_DEFAULT_TIMEZONE);
  const [hours, setHours] = useState<HoursRow[]>(() => toRows([]));
  const {domains} = useDomains(activeProject?.id ?? '');
  const {data: config} = useConfig();
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (data?.data) {
      setEnabled(data.data.enabled);
      setOriginsText(data.data.allowedOrigins.join('\n'));
      setAccentColor(data.data.accentColor);
      setLauncherPosition(data.data.launcherPosition);
      setGreeting(data.data.greeting ?? '');
      setTeamUserIds(data.data.teamUserIds);
      setReplyDomain(data.data.replyDomain ?? '');
      setReplyFromEmail(data.data.replyFromEmail ?? '');
      setEmailDelay(String(data.data.emailDelayMinutes));
      setReplyTime(data.data.replyTime);
      setOfficeHoursEnabled(data.data.officeHoursEnabled);
      setTimezone(data.data.timezone);
      setHours(toRows(data.data.officeHours));
      setRetention(String(data.data.retentionMonths));
    }
  }, [data]);

  if (!activeProject) return null;

  const lines = originsText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const invalid = lines.filter(line => !normalizeOrigin(line));
  const colorValid = HEX_COLOR.test(accentColor);
  const agents = (members?.data ?? []).filter(member => member.role === 'OWNER' || member.supportAgent);
  const standaloneUrl = `${API_URI}/widget/?key=${encodeURIComponent(activeProject.public)}`;
  const snippet = [
    '<script>',
    '  window.PlunkChat=window.PlunkChat||function(){(window.PlunkChat.q=window.PlunkChat.q||[]).push(arguments)};',
    `  PlunkChat('boot', {key: '${activeProject.public}'});`,
    '</script>',
    `<script async src="${API_URI}/widget/loader.js"></script>`,
  ].join('\n');

  const verifiedDomains = (domains ?? []).filter(domain => domain.verified).map(domain => domain.domain);
  const delayMinutes = Number(emailDelay);
  const delayValid = Number.isInteger(delayMinutes) && delayMinutes >= 1 && delayMinutes <= MESSENGER_EMAIL_DELAY_MAX_MINUTES;
  const sesRegion = config?.aws?.sesRegion;
  const retentionMonths = Number(retention);
  const retentionValid =
    Number.isInteger(retentionMonths) && retentionMonths >= 1 && retentionMonths <= MESSENGER_RETENTION_MAX_MONTHS;

  const officeHours = toDays(hours);
  const hoursValid = officeHours !== null && (!officeHoursEnabled || officeHours.length > 0);

  const saved = data?.data;
  const dirty =
    !!saved &&
    (enabled !== saved.enabled ||
      lines.join('\n') !== saved.allowedOrigins.join('\n') ||
      accentColor.toLowerCase() !== saved.accentColor ||
      launcherPosition !== saved.launcherPosition ||
      (greeting.trim() || null) !== saved.greeting ||
      teamUserIds.join(',') !== saved.teamUserIds.join(',') ||
      (replyDomain.trim().toLowerCase() || null) !== saved.replyDomain ||
      (replyFromEmail.trim().toLowerCase() || null) !== saved.replyFromEmail ||
      delayMinutes !== saved.emailDelayMinutes ||
      replyTime !== saved.replyTime ||
      officeHoursEnabled !== saved.officeHoursEnabled ||
      timezone !== saved.timezone ||
      retentionMonths !== saved.retentionMonths ||
      hoursKey(officeHours) !== hoursKey(saved.officeHours));

  const updateRow = (index: number, patch: Partial<HoursRow>) => {
    setHours(current => current.map((row, position) => (position === index ? {...row, ...patch} : row)));
  };

  const toggleOfficeHours = (value: boolean) => {
    setOfficeHoursEnabled(value);
    if (value && timezone === MESSENGER_DEFAULT_TIMEZONE && saved?.officeHours.length === 0) {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || MESSENGER_DEFAULT_TIMEZONE);
      setHours(current => current.map((row, index) => (index < 5 ? {...row, open: true} : row)));
    }
  };

  const toggleTeamMember = (userId: string, checked: boolean) => {
    setTeamUserIds(current =>
      checked ? [...current, userId].slice(0, MESSENGER_TEAM_MAX) : current.filter(id => id !== userId),
    );
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Couldn’t copy. Select the snippet and copy it by hand.');
    }
  };

  const save = async () => {
    if (invalid.length > 0) {
      toast.error(`Not a valid origin: ${invalid[0]}`);
      return;
    }
    if (!colorValid) {
      toast.error('Use a six-digit hex colour such as #111827');
      return;
    }
    if (!delayValid) {
      toast.error(`The email delay must be between 1 and ${MESSENGER_EMAIL_DELAY_MAX_MINUTES} minutes`);
      return;
    }
    if (!retentionValid) {
      toast.error(`Keep closed conversations for 1 to ${MESSENGER_RETENTION_MAX_MONTHS} months`);
      return;
    }
    if (!officeHours) {
      toast.error('Each open day needs a closing time after its opening time');
      return;
    }
    if (!hoursValid) {
      toast.error('Open at least one day, or turn office hours off');
      return;
    }
    setSaving(true);
    try {
      await network.fetch<void, typeof MessengerSettingsSchemas.update>('PATCH', `/projects/${activeProject.id}/messenger`, {
        enabled,
        allowedOrigins: lines,
        accentColor,
        launcherPosition,
        greeting: greeting.trim() || null,
        teamUserIds,
        replyDomain: replyDomain.trim() || null,
        replyFromEmail: replyFromEmail.trim() || null,
        emailDelayMinutes: delayMinutes,
        replyTime,
        officeHoursEnabled,
        officeHours,
        timezone,
        retentionMonths,
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
    <div className="space-y-6">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            The name, logo and language come from the project. Changes show the next time a visitor loads a page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="messenger-accent">Accent colour</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the accent colour"
                  value={colorValid ? accentColor : MESSENGER_DEFAULT_ACCENT}
                  disabled={!canEdit}
                  onChange={event => setAccentColor(event.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-md border border-neutral-200 bg-white p-1 disabled:cursor-not-allowed"
                />
                <Input
                  id="messenger-accent"
                  value={accentColor}
                  disabled={!canEdit}
                  onChange={event => setAccentColor(event.target.value.trim())}
                  className="font-mono"
                  maxLength={7}
                />
              </div>
              {!colorValid && <p className="text-sm text-red-600">Use a six-digit hex colour such as #111827.</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="messenger-position">Launcher position</Label>
              <Select
                value={launcherPosition}
                disabled={!canEdit}
                onValueChange={value => setLauncherPosition(value as MessengerLauncherPositionValue)}
              >
                <SelectTrigger id="messenger-position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="RIGHT">Bottom right</SelectItem>
                  <SelectItem value="LEFT">Bottom left</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="messenger-greeting">Greeting</Label>
            <Input
              id="messenger-greeting"
              value={greeting}
              disabled={!canEdit}
              maxLength={MESSENGER_GREETING_MAX_LENGTH}
              placeholder="Hi there 👋"
              onChange={event => setGreeting(event.target.value)}
            />
            <p className="text-sm text-neutral-500">Leave empty to use the default greeting in the project’s language.</p>
          </div>

          <div className="space-y-2">
            <Label>Team avatars</Label>
            <p className="text-sm text-neutral-500">
              Up to {MESSENGER_TEAM_MAX} support agents shown on the messenger’s home screen. Agents appear once they
              have set their name.
            </p>
            {agents.length === 0 ? (
              <p className="text-sm text-neutral-500">No support agents yet. Turn on inbox access in the Team tab.</p>
            ) : (
              <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
                {agents.map(agent => {
                  const checked = teamUserIds.includes(agent.userId);
                  const full = !checked && teamUserIds.length >= MESSENGER_TEAM_MAX;
                  return (
                    <li key={agent.userId} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        id={`team-${agent.userId}`}
                        checked={checked}
                        disabled={!canEdit || full}
                        onCheckedChange={value => toggleTeamMember(agent.userId, value === true)}
                      />
                      <Label htmlFor={`team-${agent.userId}`} className="flex-1 font-normal">
                        {agent.name ?? agent.email}
                        {!agent.name && <span className="ml-2 text-xs text-neutral-400">No name set yet</span>}
                      </Label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Office hours</CardTitle>
          <CardDescription>
            The messenger tells visitors when to expect a reply. Outside office hours it says when the team is back and
            asks for an email address before the visitor writes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="messenger-reply-time">Usual reply time</Label>
            <Select
              value={replyTime}
              disabled={!canEdit}
              onValueChange={value => setReplyTime(value as MessengerReplyTimeValue)}
            >
              <SelectTrigger id="messenger-reply-time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPLY_TIMES.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="messenger-office-hours">Set office hours</Label>
              <p className="text-sm text-neutral-500">When off, the team is never shown as away.</p>
            </div>
            <Switch
              id="messenger-office-hours"
              checked={officeHoursEnabled}
              disabled={!canEdit}
              onCheckedChange={toggleOfficeHours}
            />
          </div>

          {officeHoursEnabled && (
            <>
              <div className="space-y-1.5 sm:max-w-xs">
                <Label htmlFor="messenger-timezone">Time zone</Label>
                <Select value={timezone} disabled={!canEdit} onValueChange={setTimezone}>
                  <SelectTrigger id="messenger-timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeZones(timezone).map(zone => (
                      <SelectItem key={zone} value={zone}>
                        {zone.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
                  {hours.map((row, index) => {
                    const day = WEEKDAYS[index]!;
                    const start = fromClock(row.start, false);
                    const end = fromClock(row.end, true);
                    const rowInvalid = row.open && (start === null || end === null || end <= start);
                    return (
                      <li key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                        <div className="flex w-32 items-center gap-3">
                          <Checkbox
                            id={`hours-${index}`}
                            checked={row.open}
                            disabled={!canEdit}
                            onCheckedChange={value => updateRow(index, {open: value === true})}
                          />
                          <Label htmlFor={`hours-${index}`} className="font-normal">
                            {day}
                          </Label>
                        </div>
                        {row.open ? (
                          <div className="flex items-center gap-2">
                            <Input
                              type="time"
                              aria-label={`${day} opens`}
                              value={row.start}
                              disabled={!canEdit}
                              onChange={event => updateRow(index, {start: event.target.value})}
                              className="w-28"
                            />
                            <span className="text-sm text-neutral-500">to</span>
                            <Input
                              type="time"
                              aria-label={`${day} closes`}
                              aria-invalid={rowInvalid || undefined}
                              value={row.end}
                              disabled={!canEdit}
                              onChange={event => updateRow(index, {end: event.target.value})}
                              className="w-28"
                            />
                          </div>
                        ) : (
                          <span className="text-sm text-neutral-500">Closed</span>
                        )}
                        {rowInvalid && <p className="w-full text-sm text-red-600">Close after it opens.</p>}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-sm text-neutral-500">
                  One stretch per day, in the time zone above. Use 00:00 as the closing time for midnight.
                </p>
                {officeHours?.length === 0 && <p className="text-sm text-red-600">Open at least one day.</p>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email replies</CardTitle>
          <CardDescription>
            When a visitor has left an email address and hasn’t read your reply, it’s emailed to them. Their answer
            comes back into the same conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {verifiedDomains.length === 0 && (
            <p className="text-sm text-neutral-500">Verify a domain in the Domains tab before turning this on.</p>
          )}
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="messenger-reply-from">Send from</Label>
              <Input
                id="messenger-reply-from"
                type="email"
                value={replyFromEmail}
                disabled={!canEdit}
                placeholder={`support@${verifiedDomains[0] ?? 'example.com'}`}
                onChange={event => setReplyFromEmail(event.target.value)}
              />
              <p className="text-sm text-neutral-500">An address on one of your verified domains.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="messenger-reply-domain">Reply domain</Label>
              <Input
                id="messenger-reply-domain"
                value={replyDomain}
                disabled={!canEdit}
                placeholder={`reply.${verifiedDomains[0] ?? 'example.com'}`}
                onChange={event => setReplyDomain(event.target.value)}
                className="font-mono"
              />
              <p className="text-sm text-neutral-500">A subdomain used only for receiving replies.</p>
            </div>
          </div>
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="messenger-email-delay">Email after (minutes)</Label>
            <Input
              id="messenger-email-delay"
              type="number"
              inputMode="numeric"
              min={1}
              max={MESSENGER_EMAIL_DELAY_MAX_MINUTES}
              value={emailDelay}
              disabled={!canEdit}
              onChange={event => setEmailDelay(event.target.value)}
            />
            <p className="text-sm text-neutral-500">
              Also how long a visitor’s message waits unread before the team is emailed.
            </p>
            {!delayValid && (
              <p className="text-sm text-red-600">Use a whole number from 1 to {MESSENGER_EMAIL_DELAY_MAX_MINUTES}.</p>
            )}
          </div>
          {replyDomain.trim() && sesRegion && (
            <div className="space-y-1.5 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm">
              <p className="font-medium text-neutral-900">DNS record for the reply domain</p>
              <p className="break-all font-mono text-xs text-neutral-700">
                {replyDomain.trim().toLowerCase()} MX 10 inbound-smtp.{sesRegion}.amazonaws.com
              </p>
              <p className="text-neutral-500">It is also listed under the domain in the Domains tab.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data retention</CardTitle>
          <CardDescription>
            Conversations can hold sensitive details, so they aren’t kept forever. Deleted conversations and their
            files can’t be recovered.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="messenger-retention">Delete closed conversations after (months)</Label>
            <Input
              id="messenger-retention"
              type="number"
              inputMode="numeric"
              min={1}
              max={MESSENGER_RETENTION_MAX_MONTHS}
              value={retention}
              disabled={!canEdit}
              onChange={event => setRetention(event.target.value)}
            />
            {!retentionValid && (
              <p className="text-sm text-red-600">Use a whole number from 1 to {MESSENGER_RETENTION_MAX_MONTHS}.</p>
            )}
          </div>
          <p className="text-sm text-neutral-500">
            Visitors who never left an email address are deleted, with their conversations, after 90 days without a
            message. Deleting a contact deletes their conversations right away.
          </p>
        </CardContent>
      </Card>

      <SlackCard
        projectId={activeProject.id}
        connected={saved?.slackConnected ?? false}
        canEdit={canEdit}
        onChange={() => void mutate()}
      />

      {canEdit && <StickySaveBar status={saving ? 'saving' : dirty ? 'dirty' : 'idle'} onSave={save} />}

      <ProfileNameCard onSaved={() => void mutateMembers()} />

      <Card>
        <CardHeader>
          <CardTitle>Install</CardTitle>
          <CardDescription>
            Paste this before the closing body tag on every page, or in Webflow’s site-wide custom code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-neutral-950 p-4 pr-12 text-xs leading-relaxed text-neutral-100">
              {snippet}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-2 top-2 text-neutral-300 hover:bg-neutral-800 hover:text-white"
              onClick={() => void copySnippet()}
              aria-label="Copy the embed snippet"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-sm text-neutral-500">
            From your own code: <code>PlunkChat(&apos;show&apos;)</code>, <code>PlunkChat(&apos;hide&apos;)</code>, and{' '}
            <code>PlunkChat(&apos;shutdown&apos;)</code> when a visitor signs out.
          </p>

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
        </CardContent>
      </Card>

      <IdentityCard
        projectId={activeProject.id}
        publicKey={activeProject.public}
        enabled={saved?.identityVerification ?? false}
        canEdit={canEdit}
        onChange={() => void mutate()}
      />
    </div>
  );
}

interface IdentityCardProps {
  projectId: string;
  publicKey: string;
  enabled: boolean;
  canEdit: boolean;
  onChange: () => void;
}

function IdentityCard({projectId, publicKey, enabled, canEdit, onChange}: IdentityCardProps) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  const path = `/projects/${projectId}/messenger/identity-secret`;
  const reveal = async () => {
    setBusy(true);
    try {
      const result = await network.fetch<{success: boolean; data: MessengerIdentitySecret}>('GET', path);
      setSecret(result.data.secret);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t load the secret. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const result = await network.fetch<{success: boolean; data: MessengerIdentitySecret}>('POST', path);
      setSecret(result.data.secret);
      onChange();
      toast.success(enabled ? 'New secret created. Tokens signed with the old one no longer work.' : 'Secret created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t create a secret. Try again.');
    } finally {
      setBusy(false);
      setConfirmRotate(false);
    }
  };
  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Couldn’t copy. Select the secret and copy it by hand.');
    }
  };

  const example = [
    '// On your server, for the signed-in user',
    "import jwt from 'jsonwebtoken';",
    '',
    'const userToken = jwt.sign(',
    '  {sub: user.id, email: user.email, name: user.name},',
    '  process.env.MESSENGER_IDENTITY_SECRET,',
    "  {algorithm: 'HS256', expiresIn: '1h'},",
    ');',
    '',
    '// In the page, instead of the plain boot',
    `PlunkChat('boot', {key: '${publicKey}', userToken});`,
  ].join('\n');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identity verification</CardTitle>
        <CardDescription>
          Sign your users in to the messenger, so they see all their conversations on any device. Your server signs a
          short-lived token with this secret. Never put the secret in your website’s code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-neutral-700">{enabled ? 'On. Signed-in users can be verified.' : 'Not set up.'}</p>
        {canEdit && (
          <>
            {secret && (
              <div className="space-y-1.5">
                <Label htmlFor="messenger-identity-secret">Secret</Label>
                <div className="flex gap-2">
                  <Input id="messenger-identity-secret" value={secret} readOnly className="font-mono" />
                  <Button variant="outline" onClick={() => void copySecret()} aria-label="Copy the secret">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {enabled && !secret && (
                <Button variant="outline" onClick={() => void reveal()} disabled={busy}>
                  Show secret
                </Button>
              )}
              <Button
                variant={enabled ? 'ghost' : 'default'}
                onClick={() => (enabled ? setConfirmRotate(true) : void rotate())}
                disabled={busy}
              >
                {enabled ? 'Replace secret' : 'Create secret'}
              </Button>
            </div>
          </>
        )}
        {enabled && (
          <>
            <pre className="overflow-x-auto rounded-md bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-100">
              {example}
            </pre>
            <p className="text-sm text-neutral-500">
              Tokens must expire within an hour. Call <code>PlunkChat(&apos;shutdown&apos;)</code> when the user signs
              out, so the next person on that browser starts a fresh chat.
            </p>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        onConfirm={() => void rotate()}
        title="Replace the secret?"
        description="Tokens signed with the current secret stop working right away, so signed-in users can’t open the messenger until your server signs with the new one."
        confirmText="Replace secret"
        variant="destructive"
      />
    </Card>
  );
}

function ProfileNameCard({onSaved}: {onSaved: () => void}) {
  const {data: user, mutate} = useUser();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(user?.name ?? '');
  }, [user?.name]);

  const save = async () => {
    setSaving(true);
    try {
      await network.fetch<void, typeof ProfileSchemas.update>('PATCH', '/users/@me', {name: name.trim() || null});
      await mutate();
      onSaved();
      toast.success('Your name was saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save your name. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your name</CardTitle>
        <CardDescription>
          Visitors see it on your replies and team avatar. Without one, replies are signed by the team.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row">
        <Input
          aria-label="Your name"
          value={name}
          maxLength={60}
          placeholder="Maria Jensen"
          onChange={event => setName(event.target.value)}
        />
        <Button onClick={save} disabled={saving || (user?.name ?? '') === name.trim()}>
          {saving ? 'Saving…' : 'Save name'}
        </Button>
      </CardContent>
    </Card>
  );
}

interface SlackCardProps {
  projectId: string;
  connected: boolean;
  canEdit: boolean;
  onChange: () => void;
}

function SlackCard({projectId, connected, canEdit, onChange}: SlackCardProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const typed = url.trim();
  const typedValid = isSlackWebhookUrl(typed);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveUrl = (slackWebhookUrl: string | null, success: string) =>
    run(async () => {
      await network.fetch<void, typeof MessengerSettingsSchemas.update>('PATCH', `/projects/${projectId}/messenger`, {
        slackWebhookUrl,
      });
      setUrl('');
      onChange();
    }, success);

  const sendTest = () =>
    run(
      () =>
        network.fetch<void, typeof MessengerSettingsSchemas.slackTest>(
          'POST',
          `/projects/${projectId}/messenger/slack/test`,
          typed ? {url: typed} : {},
        ),
      'Test message sent. Check the channel.',
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Post new conversations, and visitor replies no one is assigned to, in a Slack channel. Create an incoming
          webhook for the channel in Slack and paste its URL here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-neutral-700">
          {connected ? 'Connected. Posts include the start of each message.' : 'Not connected.'}
        </p>
        {canEdit && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="messenger-slack-url">{connected ? 'Replace the webhook URL' : 'Webhook URL'}</Label>
              <Input
                id="messenger-slack-url"
                type="url"
                value={url}
                placeholder="https://hooks.slack.com/services/…"
                autoComplete="off"
                onChange={event => setUrl(event.target.value)}
                className="font-mono"
              />
              {typed && !typedValid && (
                <p className="text-sm text-red-600">Use a Slack incoming webhook URL, starting with https://hooks.slack.com/services/</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveUrl(typed, 'Slack webhook saved')} disabled={busy || !typedValid}>
                Save webhook
              </Button>
              <Button variant="outline" onClick={() => void sendTest()} disabled={busy || (typed ? !typedValid : !connected)}>
                Send a test
              </Button>
              {connected && (
                <Button variant="ghost" onClick={() => void saveUrl(null, 'Slack disconnected')} disabled={busy}>
                  Disconnect
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
