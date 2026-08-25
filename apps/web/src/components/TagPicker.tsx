import {Badge, Command, CommandGroup, CommandItem, CommandList, Input} from '@plunk/ui';
import type {Tag} from '@plunk/db';
import {TagSchemas} from '@plunk/shared';
import {Check, Plus, X} from 'lucide-react';
import {useCallback, useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR, {useSWRConfig} from 'swr';
import {network} from '../lib/network';

interface TagPickerProps {
  /** Currently selected tag IDs */
  value: string[];
  onChange: (ids: string[]) => void;
  /** When true, typing a name with no match offers "Create tag …" (creates + selects it) */
  allowCreate?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Inline multi-select tag combobox. Loads the project's full tag list once
 * (SWR key '/tags', shared/cached across every consumer) and filters client-side
 * — tag counts are small enough that server-side search isn't worth the
 * complexity, same assumption the segments list makes.
 */
export function TagPicker({value, onChange, allowCreate = false, placeholder = 'Add tags…', className}: TagPickerProps) {
  const {data: tags, mutate: mutateTags} = useSWR<Tag[]>('/tags', {revalidateOnFocus: false});
  const {mutate: globalMutate} = useSWRConfig();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedTags = (tags ?? []).filter(t => value.includes(t.id));
  const q = query.trim().toLowerCase();
  const matches = (tags ?? []).filter(t => !value.includes(t.id) && t.name.toLowerCase().includes(q));
  const exactMatch = (tags ?? []).some(t => t.name.toLowerCase() === q);

  const toggleTag = useCallback(
    (tagId: string) => {
      onChange(value.includes(tagId) ? value.filter(id => id !== tagId) : [...value, tagId]);
    },
    [value, onChange],
  );

  const removeTag = useCallback(
    (tagId: string) => {
      onChange(value.filter(id => id !== tagId));
    },
    [value, onChange],
  );

  const handleCreate = async () => {
    if (!query.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const created = await network.fetch<Tag, typeof TagSchemas.create>('POST', '/tags', {name: query.trim()});
      await mutateTags(prev => (prev ? [...prev, created].sort((a, b) => a.name.localeCompare(b.name)) : [created]), {
        revalidate: false,
      });
      onChange([...value, created.id]);
      setQuery('');
      void globalMutate('/tags');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create the tag. Try again.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className={className}>
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedTags.map(tag => (
            <Badge key={tag.id} variant="default" className="gap-1 pr-1">
              {tag.name}
              <button
                type="button"
                aria-label={`Remove ${tag.name}`}
                onClick={() => removeTag(tag.id)}
                className="rounded-full hover:bg-neutral-200 p-0.5 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="relative">
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          autoComplete="off"
        />

        {open && (
          <div className="absolute z-50 w-full mt-1 rounded-md border border-neutral-200 bg-white shadow-md max-h-60 overflow-y-auto">
            <Command>
              <CommandList>
                {matches.length > 0 && (
                  <CommandGroup>
                    {matches.map(tag => (
                      <CommandItem key={tag.id} value={tag.id} onSelect={() => toggleTag(tag.id)}>
                        <span className="flex-1 truncate">{tag.name}</span>
                        <span className="text-xs text-neutral-400">{tag.memberCount.toLocaleString()}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {matches.length === 0 && !allowCreate && (
                  <div className="px-3 py-2 text-sm text-neutral-500">
                    {q ? 'No matching tags' : 'No tags yet'}
                  </div>
                )}
                {allowCreate && q && !exactMatch && (
                  <CommandGroup>
                    <CommandItem value={`__create__${q}`} onSelect={() => void handleCreate()} disabled={isCreating}>
                      <Plus className="h-3.5 w-3.5 text-neutral-400" />
                      <span>Create tag &ldquo;{query.trim()}&rdquo;</span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {selectedTags.length > 0 && matches.length === 0 && (!allowCreate || !q || exactMatch) && (
                  <div className="px-3 py-1.5 text-xs text-neutral-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> All matching tags selected
                  </div>
                )}
              </CommandList>
            </Command>
          </div>
        )}
      </div>
    </div>
  );
}
