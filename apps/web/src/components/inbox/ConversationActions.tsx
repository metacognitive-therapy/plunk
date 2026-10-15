import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@plunk/ui';
import type {ConversationSchemas} from '@plunk/shared';
import type {InboxAgent, InboxConversation} from '@plunk/types';
import {AlarmClock, Check, ChevronDown, RotateCcw, UserRound} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';
import type {z} from 'zod';

import {formatDateTimeLocal, schedulePresets} from '../../lib/dateUtils';
import {network} from '../../lib/network';

const UNASSIGNED = 'unassigned';

type StatusChange = z.infer<typeof ConversationSchemas.status>;

const SNOOZE_PRESETS: {label: string; until: () => string}[] = [
  {label: 'In 3 hours', until: schedulePresets.inThreeHours},
  {label: 'Tomorrow, 9:00', until: schedulePresets.tomorrowAt9AM},
  {label: 'Next Monday, 9:00', until: schedulePresets.nextMonday},
  {label: 'In one week', until: schedulePresets.inOneWeek},
];

export function formatSnoozeDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export function ConversationActions({
  conversation,
  currentUserId,
  onChanged,
}: {
  conversation: InboxConversation;
  currentUserId: string | undefined;
  onChanged: (next: InboxConversation) => void;
}) {
  const {data: agents} = useSWR<{success: boolean; data: InboxAgent[]}>('/conversations/agents');
  const [busy, setBusy] = useState(false);
  const [pickingDate, setPickingDate] = useState(false);
  const [customDate, setCustomDate] = useState('');

  const run = async (request: () => Promise<{data: InboxConversation}>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await request();
      onChanged(result.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t update the conversation. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (change: StatusChange) =>
    run(() =>
      network.fetch<{data: InboxConversation}, typeof ConversationSchemas.status>(
        'POST',
        `/conversations/${conversation.id}/status`,
        change,
      ),
    );

  const snoozeUntil = (localValue: string) => {
    const until = new Date(localValue);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      toast.error('Pick a time in the future.');
      return;
    }
    void setStatus({status: 'SNOOZED', snoozedUntil: until});
  };

  const assign = (assigneeId: string | null) =>
    run(() =>
      network.fetch<{data: InboxConversation}, typeof ConversationSchemas.assign>(
        'POST',
        `/conversations/${conversation.id}/assignee`,
        {assigneeId},
      ),
    );

  const assignee = agents?.data.find(agent => agent.id === conversation.assigneeId);
  const assigneeLabel = conversation.assigneeId
    ? conversation.assigneeId === currentUserId
      ? 'You'
      : (assignee?.name ?? 'Assigned')
    : 'Unassigned';
  const others = agents?.data.filter(agent => agent.id !== currentUserId) ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy} aria-label="Assignee">
            <UserRound className="mr-1.5 h-4 w-4" />
            <span className="max-w-[9rem] truncate">{assigneeLabel}</span>
            <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={conversation.assigneeId ?? UNASSIGNED}
            onValueChange={value => void assign(value === UNASSIGNED ? null : value)}
          >
            {currentUserId && <DropdownMenuRadioItem value={currentUserId}>You</DropdownMenuRadioItem>}
            {others.map(agent => (
              <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                <span className="truncate">{agent.name}</span>
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuRadioItem value={UNASSIGNED}>Unassigned</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {conversation.status !== 'CLOSED' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy}>
              <AlarmClock className="mr-1.5 h-4 w-4" />
              Snooze
              <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
            {SNOOZE_PRESETS.map(preset => (
              <DropdownMenuItem key={preset.label} onSelect={() => snoozeUntil(preset.until())}>
                {preset.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => void setStatus({status: 'SNOOZED', snoozedUntil: null})}>
              The visitor replies
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setCustomDate(schedulePresets.tomorrowAt9AM());
                setPickingDate(true);
              }}
            >
              Pick a date and time…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {conversation.status === 'OPEN' ? (
        <Button size="sm" disabled={busy} onClick={() => void setStatus({status: 'CLOSED'})}>
          <Check className="mr-1.5 h-4 w-4" />
          Close
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void setStatus({status: 'OPEN'})}>
          <RotateCcw className="mr-1.5 h-4 w-4" />
          {conversation.status === 'SNOOZED' ? 'Unsnooze' : 'Reopen'}
        </Button>
      )}

      <Dialog open={pickingDate} onOpenChange={setPickingDate}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze until</DialogTitle>
            <DialogDescription>The conversation comes back to Open at this time, or sooner if the visitor writes.</DialogDescription>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={customDate}
            min={formatDateTimeLocal(new Date())}
            onChange={event => setCustomDate(event.target.value)}
            aria-label="Snooze until"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickingDate(false)}>
              Cancel
            </Button>
            <Button
              disabled={!customDate || busy}
              onClick={() => {
                setPickingDate(false);
                snoozeUntil(customDate);
              }}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
