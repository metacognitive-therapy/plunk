import type {SequenceResponse} from '@plunk/types';
import {SequenceSchemas} from '@plunk/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconSpinner,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@plunk/ui';
import {ListOrdered, Mail, Plus, Users} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {DashboardLayout} from '../../components/DashboardLayout';
import {formatRelativeTime} from '../../lib/dateUtils';
import {network} from '../../lib/network';

const STATUS_VARIANTS: Record<string, {label: string; className: string}> = {
  DRAFT: {label: 'Draft', className: 'bg-neutral-100 text-neutral-600'},
  ACTIVE: {label: 'Active', className: 'bg-emerald-100 text-emerald-700'},
  PAUSED: {label: 'Paused', className: 'bg-amber-100 text-amber-700'},
};

function CreateSequenceDialog({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [type, setType] = useState('MARKETING');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const created = await network.fetch<SequenceResponse, typeof SequenceSchemas.create>('POST', '/sequences', {
        name,
        type: type as 'MARKETING' | 'TRANSACTIONAL' | 'HEADLESS',
      });
      toast.success('Sequence created');
      onOpenChange(false);
      void router.push(`/sequences/${created.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create the sequence. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Create sequence</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sequence-name">Name</Label>
            <Input
              id="sequence-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Weekly newsletter"
              maxLength={100}
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sequence-type">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="sequence-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MARKETING">Marketing</SelectItem>
                <SelectItem value="TRANSACTIONAL">Transactional</SelectItem>
                <SelectItem value="HEADLESS">Headless</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-neutral-500">Applies to every email in the sequence.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? 'Creating…' : 'Create sequence'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SequencesPage() {
  const {data: sequences, isLoading} = useSWR<SequenceResponse[]>('/sequences', {revalidateOnFocus: false});
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <NextSeo title="Sequences" />
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">Sequences</h1>
              <p className="text-neutral-500 mt-2 text-sm sm:text-base">
                An ordered series of emails that keeps growing. Everyone starts at the first email, and contacts who
                are caught up receive each new one as soon as you publish it.
              </p>
            </div>
            <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Create sequence</span>
              <span className="sm:hidden">Create</span>
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <IconSpinner />
            </div>
          ) : sequences?.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={ListOrdered}
                  title="No sequences yet"
                  description="Create a sequence to send an evolving series of emails, one step at a time."
                  action={
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="h-4 w-4" />
                      Create sequence
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sequences?.map(sequence => {
                const status = STATUS_VARIANTS[sequence.status] ?? STATUS_VARIANTS.DRAFT!;
                return (
                  <Card key={sequence.id} className="transition-colors hover:border-neutral-300 flex flex-col">
                    <Link
                      href={`/sequences/${sequence.id}`}
                      className="flex-1 block p-6 pb-4 hover:bg-neutral-50/50 transition-colors rounded-t-xl focus-visible:outline-none"
                    >
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <h3 className="font-semibold text-neutral-900 leading-snug">{sequence.name}</h3>
                        <Badge className={status.className}>{status.label}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-neutral-400" />
                          <strong className="font-semibold text-neutral-900">{sequence.stepCount}</strong>
                          <span className="text-neutral-400 text-xs">emails</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 text-neutral-400" />
                          <strong className="font-semibold text-neutral-900">
                            {sequence.subscriptionCount.toLocaleString()}
                          </strong>
                          <span className="text-neutral-400 text-xs">enrolled</span>
                        </span>
                      </div>
                    </Link>
                    <div className="px-6 py-3 border-t border-neutral-100">
                      <span className="text-xs text-neutral-400">Updated {formatRelativeTime(sequence.updatedAt)}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </DashboardLayout>

      <CreateSequenceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
