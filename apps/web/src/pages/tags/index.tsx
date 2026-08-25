import {
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconSpinner,
  Input,
  Label,
} from '@plunk/ui';
import type {Tag} from '@plunk/db';
import {TagSchemas} from '@plunk/shared';
import {DashboardLayout} from '../../components/DashboardLayout';
import {network} from '../../lib/network';
import {formatRelativeTime} from '../../lib/dateUtils';
import {Edit, Plus, Search, Tag as TagIcon, Trash2, Users, X} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useMemo, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

function TagFormDialog({
  open,
  onOpenChange,
  tag,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag: Tag | null;
  onSaved: (tag: Tag) => void;
}) {
  const [name, setName] = useState(tag?.name ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [prevTag, setPrevTag] = useState(tag);

  if (tag !== prevTag) {
    setPrevTag(tag);
    setName(tag?.name ?? '');
  }

  const isEdit = !!tag;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const saved = isEdit
        ? await network.fetch<Tag, typeof TagSchemas.update>('PATCH', `/tags/${tag.id}`, {name})
        : await network.fetch<Tag, typeof TagSchemas.create>('POST', '/tags', {name});
      toast.success(isEdit ? 'Tag renamed' : 'Tag created');
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Couldn't ${isEdit ? 'rename' : 'create'} the tag. Try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Rename tag' : 'Create tag'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. VIP customer"
              maxLength={100}
              autoFocus
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? 'Saving…' : isEdit ? 'Save' : 'Create tag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TagsPage() {
  const {data: tags, mutate, isLoading} = useSWR<Tag[]>('/tags', {revalidateOnFocus: false});

  const [searchInput, setSearchInput] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const filteredTags = useMemo(() => {
    if (!tags || !searchInput.trim()) return tags;
    const q = searchInput.toLowerCase();
    return tags.filter(t => t.name.toLowerCase().includes(q));
  }, [tags, searchInput]);

  const handleSaved = (saved: Tag) => {
    void mutate(prev => {
      if (!prev) return prev;
      const exists = prev.some(t => t.id === saved.id);
      const next = exists ? prev.map(t => (t.id === saved.id ? saved : t)) : [...prev, saved];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    }, {revalidate: false});
  };

  const handleDelete = async () => {
    if (!tagToDelete) return;
    try {
      await network.fetch('DELETE', `/tags/${tagToDelete.id}`);
      toast.success('Tag deleted');
      void mutate(prev => prev?.filter(t => t.id !== tagToDelete.id), {revalidate: false});
    } catch (error) {
      // Delete is blocked (409) when the tag is referenced by a campaign, an
      // enabled workflow, or a segment — surface that reason instead of a generic failure.
      toast.error(error instanceof Error ? error.message : "Couldn't delete the tag. Try again.");
    } finally {
      setTagToDelete(null);
      setShowDeleteDialog(false);
    }
  };

  return (
    <>
      <NextSeo title="Tags" />
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">Tags</h1>
              <p className="text-neutral-500 mt-2 text-sm sm:text-base">
                Label contacts to target them in campaigns, workflows, and segments.
              </p>
            </div>
            <Button
              className="w-full sm:w-auto"
              onClick={() => {
                setEditingTag(null);
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Create tag</span>
              <span className="sm:hidden">Create</span>
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
            <Input
              type="text"
              placeholder="Search tags…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pl-10 pr-10"
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <IconSpinner />
            </div>
          ) : filteredTags?.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={TagIcon}
                  title={searchInput ? 'No tags match' : 'No tags yet'}
                  description={
                    searchInput ? 'Try a different search term.' : 'Tags applied via /v1/track, imports, or the API will show up here too.'
                  }
                  action={
                    !searchInput ? (
                      <Button
                        onClick={() => {
                          setEditingTag(null);
                          setFormOpen(true);
                        }}
                      >
                        <Plus className="h-4 w-4" />
                        Create tag
                      </Button>
                    ) : undefined
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredTags?.map(tag => (
                <Card key={tag.id} className="transition-colors hover:border-neutral-300 flex flex-col">
                  <Link
                    href={`/contacts?tags=${tag.id}`}
                    className="flex-1 block p-6 pb-4 hover:bg-neutral-50/50 transition-colors rounded-t-xl focus-visible:outline-none"
                    aria-label={`View contacts tagged ${tag.name}`}
                  >
                    <h3 className="font-semibold text-neutral-900 leading-snug mb-3">{tag.name}</h3>
                    <div className="flex items-center gap-1.5 text-sm">
                      <Users className="h-3.5 w-3.5 text-neutral-400" />
                      <strong className="font-semibold text-neutral-900">{tag.memberCount.toLocaleString()}</strong>
                      <span className="text-neutral-400 text-xs">contacts</span>
                    </div>
                  </Link>
                  <div className="px-6 py-3 border-t border-neutral-100 flex items-center justify-between">
                    <span className="text-xs text-neutral-400">Updated {formatRelativeTime(tag.updatedAt)}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Rename tag"
                        onClick={() => {
                          setEditingTag(tag);
                          setFormOpen(true);
                        }}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Delete tag"
                        onClick={() => {
                          setTagToDelete(tag);
                          setShowDeleteDialog(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <TagFormDialog open={formOpen} onOpenChange={setFormOpen} tag={editingTag} onSaved={handleSaved} />

        <ConfirmDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          title={`Delete "${tagToDelete?.name}"?`}
          description="Contacts keep their other tags. This can't be undone. Blocked if the tag is used by a campaign, an enabled workflow, or a segment."
          confirmText="Delete tag"
          variant="destructive"
        />
      </DashboardLayout>
    </>
  );
}
