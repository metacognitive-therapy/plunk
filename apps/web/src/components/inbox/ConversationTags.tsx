import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@plunk/ui';
import type {ConversationSchemas} from '@plunk/shared';
import type {InboxTag} from '@plunk/types';
import {Check, Plus, Tag as TagIcon, X} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../../lib/network';

export function useConversationTags() {
  return useSWR<{success: boolean; data: InboxTag[]}>('/conversations/tags');
}

export function TagChip({tag, onRemove}: {tag: InboxTag; onRemove?: () => void}) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 ring-1 ring-inset ring-sky-200">
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove tag ${tag.name}`} className="rounded-full hover:text-sky-950">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function ConversationTags({
  conversationId,
  tags,
  onChanged,
}: {
  conversationId: string;
  tags: InboxTag[];
  onChanged: (tags: InboxTag[]) => void;
}) {
  const {data: all, mutate: mutateAll} = useConversationTags();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const applied = new Set(tags.map(tag => tag.id));
  const term = search.trim();
  const exists = (all?.data ?? []).some(tag => tag.name.toLowerCase() === term.toLowerCase());

  const run = async (request: () => Promise<{data: InboxTag[]}>) => {
    if (busy) return;
    setBusy(true);
    try {
      onChanged((await request()).data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t update the tags. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (tag: InboxTag) =>
    run(() =>
      applied.has(tag.id)
        ? network.fetch<{data: InboxTag[]}>('DELETE', `/conversations/${conversationId}/tags/${tag.id}`)
        : network.fetch<{data: InboxTag[]}, typeof ConversationSchemas.applyTag>(
            'POST',
            `/conversations/${conversationId}/tags`,
            {tagId: tag.id},
          ),
    );

  const create = () =>
    run(async () => {
      const created = await network.fetch<{data: InboxTag}, typeof ConversationSchemas.tag>('POST', '/conversations/tags', {
        name: term,
      });
      setSearch('');
      void mutateAll();
      return network.fetch<{data: InboxTag[]}, typeof ConversationSchemas.applyTag>(
        'POST',
        `/conversations/${conversationId}/tags`,
        {tagId: created.data.id},
      );
    });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map(tag => (
        <TagChip key={tag.id} tag={tag} onRemove={() => void toggle(tag)} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-neutral-500" disabled={busy}>
            <TagIcon className="mr-1 h-3 w-3" />
            {tags.length === 0 ? 'Add tag' : <Plus className="h-3 w-3" aria-label="Add tag" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            <CommandInput placeholder="Find or create a tag…" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>{term ? 'No tag with that name.' : 'No tags yet.'}</CommandEmpty>
              {(all?.data.length ?? 0) > 0 && (
                <CommandGroup>
                  {all?.data.map(tag => (
                    <CommandItem key={tag.id} value={tag.name} onSelect={() => void toggle(tag)}>
                      <Check className={`mr-2 h-4 w-4 ${applied.has(tag.id) ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="truncate">{tag.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {term && !exists && (
                <CommandGroup forceMount>
                  <CommandItem value={`create ${term}`} onSelect={() => void create()} forceMount>
                    <Plus className="mr-2 h-4 w-4" />
                    <span className="truncate">Create “{term}”</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
