import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@plunk/ui';
import type {ConversationSchemas} from '@plunk/shared';
import type {InboxTag, SavedReply} from '@plunk/types';
import {Pencil, Plus, Trash2} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../../lib/network';
import {useConversationTags} from './ConversationTags';

const errorMessage = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export function InboxLibrarySettings() {
  return (
    <div className="space-y-6">
      <SavedRepliesCard />
      <TagsCard />
    </div>
  );
}

function SavedRepliesCard() {
  const {data, mutate} = useSWR<{success: boolean; data: SavedReply[]}>('/conversations/saved-replies');
  const [editing, setEditing] = useState<SavedReply | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const replies = data?.data ?? [];

  const remove = async (reply: SavedReply) => {
    try {
      await network.fetch('DELETE', `/conversations/saved-replies/${reply.id}`);
      await mutate();
      toast.success('Saved reply deleted');
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t delete the saved reply.'));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Saved replies</CardTitle>
          <CardDescription>
            Answers your team inserts with <span className="font-mono">#</span> in the Inbox. Variables such as{' '}
            <span className="font-mono">{'{{firstName ?? there}}'}</span> are filled in from the contact.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1.5 h-4 w-4" />
          New reply
        </Button>
      </CardHeader>
      <CardContent>
        {replies.length === 0 ? (
          <p className="text-sm text-neutral-500">No saved replies yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {replies.map(reply => (
              <li key={reply.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900">{reply.title}</div>
                  <div className="line-clamp-2 text-xs text-neutral-500">{reply.body}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(reply)} aria-label={`Edit ${reply.title}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(reply)} aria-label={`Delete ${reply.title}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <SavedReplyDialog
          reply={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void mutate()}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={open => !open && setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove(deleting);
          setDeleting(null);
        }}
        title="Delete saved reply?"
        description={`“${deleting?.title ?? ''}” will no longer be available in the Inbox.`}
        confirmText="Delete"
        variant="destructive"
      />
    </Card>
  );
}

function SavedReplyDialog({reply, onClose, onSaved}: {reply: SavedReply | null; onClose: () => void; onSaved: () => void}) {
  const [title, setTitle] = useState(reply?.title ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (reply) {
        await network.fetch<{data: SavedReply}, typeof ConversationSchemas.savedReplyUpdate>(
          'PATCH',
          `/conversations/saved-replies/${reply.id}`,
          {title, body},
        );
      } else {
        await network.fetch<{data: SavedReply}, typeof ConversationSchemas.savedReply>(
          'POST',
          '/conversations/saved-replies',
          {title, body},
        );
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save the reply.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reply ? 'Edit saved reply' : 'New saved reply'}</DialogTitle>
          <DialogDescription>
            Use <span className="font-mono">{'{{firstName ?? there}}'}</span> or any contact field. A fallback after{' '}
            <span className="font-mono">??</span> is used when the field is empty.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="saved-reply-title">Title</Label>
            <Input id="saved-reply-title" value={title} maxLength={80} onChange={event => setTitle(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="saved-reply-body">Reply</Label>
            <Textarea
              id="saved-reply-body"
              value={body}
              rows={6}
              maxLength={5000}
              onChange={event => setBody(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !title.trim() || !body.trim()} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TagsCard() {
  const {data, mutate} = useConversationTags();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{tag: InboxTag; name: string} | null>(null);
  const [deleting, setDeleting] = useState<InboxTag | null>(null);
  const tags = data?.data ?? [];

  const create = async () => {
    try {
      await network.fetch<{data: InboxTag}, typeof ConversationSchemas.tag>('POST', '/conversations/tags', {name});
      setName('');
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t create the tag.'));
    }
  };

  const rename = async () => {
    if (!renaming) return;
    try {
      await network.fetch<{data: InboxTag}, typeof ConversationSchemas.tag>(
        'PATCH',
        `/conversations/tags/${renaming.tag.id}`,
        {name: renaming.name},
      );
      setRenaming(null);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t rename the tag.'));
    }
  };

  const remove = async (tag: InboxTag) => {
    try {
      await network.fetch('DELETE', `/conversations/tags/${tag.id}`);
      await mutate();
      toast.success(`Tag ${tag.name} deleted`);
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t delete the tag.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation tags</CardTitle>
        <CardDescription>
          Labels for conversations, such as Billing or Bug. They are separate from contact tags and can filter the Inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Input
            value={name}
            maxLength={40}
            placeholder="New tag name"
            aria-label="New tag name"
            onChange={event => setName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim()}>
            Add tag
          </Button>
        </form>
        {tags.length === 0 ? (
          <p className="text-sm text-neutral-500">No conversation tags yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {tags.map(tag => (
              <li key={tag.id} className="flex items-center gap-2 px-3 py-2">
                {renaming?.tag.id === tag.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={event => {
                      event.preventDefault();
                      void rename();
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.name}
                      maxLength={40}
                      aria-label="Tag name"
                      onChange={event => setRenaming({tag, name: event.target.value})}
                    />
                    <Button type="submit" size="sm" disabled={!renaming.name.trim()}>
                      Save
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">{tag.name}</span>
                    <Button variant="ghost" size="sm" onClick={() => setRenaming({tag, name: tag.name})} aria-label={`Rename ${tag.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(tag)} aria-label={`Delete ${tag.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={open => !open && setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove(deleting);
          setDeleting(null);
        }}
        title="Delete tag?"
        description={`“${deleting?.name ?? ''}” is removed from every conversation that has it. Contact tags are not affected.`}
        confirmText="Delete"
        variant="destructive"
      />
    </Card>
  );
}
