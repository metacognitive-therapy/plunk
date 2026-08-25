import {DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors} from '@dnd-kit/core';
import {restrictToParentElement, restrictToVerticalAxis} from '@dnd-kit/modifiers';
import {SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import type {Tag} from '@plunk/db';
import {MAX_DELAY_MINUTES, SequenceSchemas} from '@plunk/shared';
import type {SequenceStatsResponse, SequenceStepResponse, SequenceWithStepsResponse} from '@plunk/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconSpinner,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@plunk/ui';
import {ArrowLeft, GripVertical, Mail, Plus, Send, Trash2, UserPlus} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';
import type {z} from 'zod';

import {DashboardLayout} from '../../components/DashboardLayout';
import {EmailEditor} from '../../components/EmailEditor';
import {EmailSettings} from '../../components/EmailSettings';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {network} from '../../lib/network';

const STATUS_VARIANTS: Record<string, {label: string; className: string}> = {
  DRAFT: {label: 'Draft', className: 'bg-neutral-100 text-neutral-600'},
  ACTIVE: {label: 'Active', className: 'bg-emerald-100 text-emerald-700'},
  PAUSED: {label: 'Paused', className: 'bg-amber-100 text-amber-700'},
};

const DELAY_UNITS = {minutes: 1, hours: 60, days: 1440} as const;

type DelayUnit = keyof typeof DELAY_UNITS;

/**
 * Splits a stored delay back into the largest whole unit that fits, so reopening
 * a step shows "2 hours" rather than "120 minutes". The ladder has to match
 * `formatDelay` below or the editor would contradict the row it was opened from.
 */
function decomposeDelay(minutes: number): {value: number; unit: DelayUnit} {
  if (minutes === 0) return {value: 0, unit: 'minutes'}; // Not "0 days"
  if (minutes % DELAY_UNITS.days === 0) return {value: minutes / DELAY_UNITS.days, unit: 'days'};
  if (minutes % DELAY_UNITS.hours === 0) return {value: minutes / DELAY_UNITS.hours, unit: 'hours'};
  return {value: minutes, unit: 'minutes'};
}

/** Renders a delay in the largest whole unit that fits, for compact display. */
function formatDelay(minutes: number): string {
  if (minutes === 0) return 'Immediately';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 === 1 ? '' : 's'} later`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 === 1 ? '' : 's'} later`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} later`;
}

function SortableStep({
  step,
  index,
  onEdit,
  onPublish,
  onDelete,
}: {
  step: SequenceStepResponse;
  index: number;
  onEdit: () => void;
  onPublish: () => void;
  onDelete: () => void;
}) {
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: step.id});

  return (
    <div
      ref={setNodeRef}
      style={{transform: CSS.Transform.toString(transform), transition}}
      className={`flex items-center gap-3 p-4 bg-white border rounded-lg ${
        isDragging ? 'border-neutral-400 shadow-lg z-10 relative' : 'border-neutral-200'
      }`}
    >
      <button
        type="button"
        className="cursor-grab active:cursor-grabbing text-neutral-400 hover:text-neutral-600 touch-none"
        aria-label={`Reorder ${step.subject}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-neutral-100 text-neutral-600 text-xs font-semibold flex items-center justify-center">
        {index + 1}
      </div>

      <button type="button" onClick={onEdit} className="flex-1 min-w-0 text-left group">
        <div className="flex items-center gap-2">
          <span className="font-medium text-neutral-900 truncate group-hover:underline">{step.subject}</span>
          <Badge className={step.published ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-100 text-neutral-600'}>
            {step.published ? 'Published' : 'Draft'}
          </Badge>
        </div>
        <span className="text-xs text-neutral-500">{formatDelay(step.delayMinutes)}</span>
      </button>

      <div className="flex items-center gap-1">
        {!step.published && (
          <Button variant="ghost" size="sm" title="Publish this email" onClick={onPublish}>
            <Send className="h-4 w-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" title="Delete step" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      </div>
    </div>
  );
}

function StepEditorDialog({
  sequenceId,
  step,
  open,
  onOpenChange,
  onSaved,
}: {
  sequenceId: string;
  step: SequenceStepResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [delayValue, setDelayValue] = useState(0);
  const [delayUnit, setDelayUnit] = useState<DelayUnit>('minutes');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [prevStep, setPrevStep] = useState<SequenceStepResponse | null | undefined>(undefined);
  const [prevOpen, setPrevOpen] = useState(false);

  // Reset every time the dialog opens, not only when a different step is passed
  // in: adding two emails in a row leaves `step` at null both times, which would
  // otherwise reopen the form still holding the previous email's subject and body.
  if (open !== prevOpen || step !== prevStep) {
    setPrevOpen(open);
    setPrevStep(step);
    if (open) {
      setSubject(step?.subject ?? '');
      setBody(step?.body ?? '');
      const delay = decomposeDelay(step?.delayMinutes ?? 0);
      setDelayValue(delay.value);
      setDelayUnit(delay.unit);
    }
  }

  const delayMinutes = delayValue * DELAY_UNITS[delayUnit];

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (step) {
        await network.fetch<SequenceStepResponse, typeof SequenceSchemas.updateStep>(
          'PATCH',
          `/sequences/${sequenceId}/steps/${step.id}`,
          {subject, body, delayMinutes},
        );
      } else {
        await network.fetch<SequenceStepResponse, typeof SequenceSchemas.createStep>(
          'POST',
          `/sequences/${sequenceId}/steps`,
          {subject, body, delayMinutes},
        );
      }
      toast.success(step ? 'Email saved' : 'Email added as a draft');
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the email. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[860px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step ? 'Edit email' : 'Add email'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="step-subject">Subject</Label>
              <Input
                id="step-subject"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="e.g. Welcome to week one"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="step-delay">Delay</Label>
              <div className="flex gap-2">
                <Input
                  id="step-delay"
                  type="number"
                  min={0}
                  max={Math.floor(MAX_DELAY_MINUTES / DELAY_UNITS[delayUnit])}
                  className="flex-1"
                  value={delayValue}
                  onChange={e => setDelayValue(Math.max(0, parseInt(e.target.value, 10) || 0))}
                />
                <Select value={delayUnit} onValueChange={value => setDelayUnit(value as DelayUnit)}>
                  <SelectTrigger className="w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                    <SelectItem value="days">Days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-neutral-500">
                {delayMinutes === 0 ? 'Sent as soon as the contact is eligible.' : "After the contact's previous email."}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Content</Label>
            <EmailEditor value={body} onChange={setBody} subject={subject} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !subject.trim() || !body.trim() || delayMinutes > MAX_DELAY_MINUTES}
          >
            {isSubmitting ? 'Saving…' : step ? 'Save' : 'Add email'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SequenceDetailPage() {
  const router = useRouter();
  const {id} = router.query;
  const sequenceId = typeof id === 'string' ? id : '';
  const {activeProject} = useActiveProject();

  const {data: sequence, mutate, isLoading} = useSWR<SequenceWithStepsResponse>(
    sequenceId ? `/sequences/${sequenceId}` : null,
    {revalidateOnFocus: false},
  );
  const {data: stats} = useSWR<SequenceStatsResponse>(sequenceId ? `/sequences/${sequenceId}/stats` : null, {
    revalidateOnFocus: false,
  });
  const {data: tags} = useSWR<Tag[]>('/tags', {revalidateOnFocus: false});

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<SequenceStepResponse | null>(null);
  const [stepToDelete, setStepToDelete] = useState<SequenceStepResponse | null>(null);
  const [enrollEmail, setEnrollEmail] = useState('');
  const [isEnrolling, setIsEnrolling] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {activationConstraint: {distance: 4}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
  );

  const patchSequence = async (data: z.infer<typeof SequenceSchemas.update>) => {
    try {
      await network.fetch<SequenceWithStepsResponse, typeof SequenceSchemas.update>(
        'PATCH',
        `/sequences/${sequenceId}`,
        data,
      );
      void mutate();
      toast.success('Sequence updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the sequence. Try again.");
      void mutate();
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const {active, over} = event;
    if (!over || active.id === over.id || !sequence) return;

    const oldIndex = sequence.steps.findIndex(step => step.id === active.id);
    const newIndex = sequence.steps.findIndex(step => step.id === over.id);
    const reordered = arrayMove(sequence.steps, oldIndex, newIndex);

    // Optimistic: show the new order immediately, roll back if the API rejects it.
    void mutate({...sequence, steps: reordered}, {revalidate: false});

    try {
      await network.fetch<{success: boolean}, typeof SequenceSchemas.reorderSteps>(
        'POST',
        `/sequences/${sequenceId}/steps/reorder`,
        {stepIds: reordered.map(step => step.id)},
      );
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't reorder the emails. Try again.");
      void mutate();
    }
  };

  const handlePublish = async (step: SequenceStepResponse) => {
    try {
      await network.fetch('POST', `/sequences/${sequenceId}/steps/${step.id}/publish`);
      toast.success('Email published — it will start sending on the next delivery pass');
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't publish the email. Try again.");
    }
  };

  const handleDeleteStep = async () => {
    if (!stepToDelete) return;
    try {
      await network.fetch('DELETE', `/sequences/${sequenceId}/steps/${stepToDelete.id}`);
      toast.success('Email deleted');
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete the email. Try again.");
    } finally {
      setStepToDelete(null);
    }
  };

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsEnrolling(true);
    try {
      const contacts = await network.fetch<{data: {id: string; email: string}[]}>(
        'GET',
        `/contacts?search=${encodeURIComponent(enrollEmail)}&limit=1`,
      );
      const contact = contacts?.data?.find(c => c.email.toLowerCase() === enrollEmail.trim().toLowerCase());
      if (!contact) {
        toast.error('No contact found with that email');
        return;
      }

      await network.fetch<{enrolled: number; skipped: number}, typeof SequenceSchemas.enroll>(
        'POST',
        `/sequences/${sequenceId}/contacts`,
        {mode: 'ids', contactIds: [contact.id]},
      );
      toast.success(`${contact.email} enrolled`);
      setEnrollEmail('');
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't enroll the contact. Try again.");
    } finally {
      setIsEnrolling(false);
    }
  };

  if (isLoading || !sequence) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-24">
          <IconSpinner />
        </div>
      </DashboardLayout>
    );
  }

  const status = STATUS_VARIANTS[sequence.status] ?? STATUS_VARIANTS.DRAFT!;

  return (
    <>
      <NextSeo title={sequence.name} />
      <DashboardLayout>
        <div className="space-y-6">
          <div>
            <Link
              href="/sequences"
              className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 transition-colors mb-3"
            >
              <ArrowLeft className="h-4 w-4" />
              Sequences
            </Link>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 truncate">{sequence.name}</h1>
                <Badge className={status.className}>{status.label}</Badge>
              </div>
              <Select value={sequence.status} onValueChange={value => patchSequence({status: value as SequenceWithStepsResponse['status']})}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="PAUSED">Paused</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              {label: 'Enrolled', value: sequence.subscriptionCount},
              {label: 'Sent', value: stats?.sent ?? 0},
              {label: 'Opened', value: stats?.opened ?? 0},
              {label: 'Clicked', value: stats?.clicked ?? 0},
            ].map(stat => (
              <Card key={stat.label}>
                <CardContent className="p-4">
                  <p className="text-xs text-neutral-500">{stat.label}</p>
                  <p className="text-2xl font-bold text-neutral-900">{stat.value.toLocaleString()}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Emails</CardTitle>
                <CardDescription>
                  Drag to reorder. Everyone starts at the first email; reordering never re-sends or skips an email
                  someone already received.
                </CardDescription>
              </div>
              <Button
                onClick={() => {
                  setEditingStep(null);
                  setEditorOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                Add email
              </Button>
            </CardHeader>
            <CardContent>
              {sequence.steps.length === 0 ? (
                <div className="text-center py-10 text-sm text-neutral-500">
                  <Mail className="h-8 w-8 mx-auto mb-3 text-neutral-300" />
                  No emails yet. Add the first one to get started.
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={sequence.steps.map(step => step.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {sequence.steps.map((step, index) => (
                        <SortableStep
                          key={step.id}
                          step={step}
                          index={index}
                          onEdit={() => {
                            setEditingStep(step);
                            setEditorOpen(true);
                          }}
                          onPublish={() => void handlePublish(step)}
                          onDelete={() => setStepToDelete(step)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Enrollment</CardTitle>
                <CardDescription>
                  Enroll contacts one at a time here, in bulk from the contacts list, or automatically when a tag is
                  applied.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={handleEnroll} className="space-y-1.5">
                  <Label htmlFor="enroll-email">Enroll a contact</Label>
                  <div className="flex gap-2">
                    <Input
                      id="enroll-email"
                      type="email"
                      value={enrollEmail}
                      onChange={e => setEnrollEmail(e.target.value)}
                      placeholder="contact@example.com"
                    />
                    <Button type="submit" disabled={isEnrolling || !enrollEmail.trim()}>
                      <UserPlus className="h-4 w-4" />
                    </Button>
                  </div>
                </form>

                <div className="space-y-1.5">
                  <Label htmlFor="enroll-tag">Auto-enroll when this tag is applied</Label>
                  <Select
                    value={sequence.enrollTagId ?? 'none'}
                    onValueChange={value => patchSequence({enrollTagId: value === 'none' ? null : value})}
                  >
                    <SelectTrigger id="enroll-tag">
                      <SelectValue placeholder="No tag" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No tag</SelectItem>
                      {tags?.map(tag => (
                        <SelectItem key={tag.id} value={tag.id}>
                          {tag.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-neutral-500">
                    Only fires while the sequence is active. Removing the tag later never unenrolls anyone.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Email settings</CardTitle>
                <CardDescription>Sender details for every email in this sequence.</CardDescription>
              </CardHeader>
              <CardContent>
                <EmailSettings
                  from={sequence.from || ''}
                  fromName={sequence.fromName || ''}
                  replyTo={sequence.replyTo || ''}
                  onFromChange={value => void patchSequence({from: value})}
                  onFromNameChange={value => void patchSequence({fromName: value})}
                  onReplyToChange={value => void patchSequence({replyTo: value})}
                  fromNamePlaceholder={activeProject?.name || 'Your Company'}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </DashboardLayout>

      <StepEditorDialog
        sequenceId={sequenceId}
        step={editingStep}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSaved={() => void mutate()}
      />

      <ConfirmDialog
        open={!!stepToDelete}
        onOpenChange={open => !open && setStepToDelete(null)}
        title="Delete this email?"
        description={`"${stepToDelete?.subject}" will be removed from the sequence. Contacts who already received it keep their history.`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleDeleteStep}
      />
    </>
  );
}
