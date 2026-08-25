import {Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import type {Tag} from '@plunk/db';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {type EditStepDialogProps, getStepConfig, StepDialogShell, useStepUpdate} from './shared';

export function TagActionStepDialog({step, workflowId, open, onOpenChange, onSuccess}: EditStepDialogProps) {
  const config = getStepConfig(step);
  const [name, setName] = useState(step.name);
  const [tagId, setTagId] = useState(typeof config.tagId === 'string' ? config.tagId : '');

  const {data: tags, isLoading: loadingTags} = useSWR<Tag[]>(open ? '/tags' : null, {revalidateOnFocus: false});
  const {update, isSubmitting} = useStepUpdate(workflowId, step.id);

  const actionLabel = step.type === 'REMOVE_TAG' ? 'remove' : 'apply';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!tagId) {
      toast.error('Please select a tag');
      return;
    }

    const ok = await update({name, config: {tagId}});

    if (ok) {
      onOpenChange(false);
      onSuccess();
    }
  };

  return (
    <StepDialogShell
      step={step}
      open={open}
      onOpenChange={onOpenChange}
      name={name}
      onNameChange={setName}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
    >
      <div>
        <Label htmlFor="editStepTag">
          Tag to {actionLabel}
          <span className="text-red-500"> *</span>
        </Label>
        {loadingTags ? (
          <div className="flex items-center gap-2 px-3 py-2 border border-neutral-200 rounded-lg text-sm text-neutral-500 mt-1.5">
            Loading tags…
          </div>
        ) : (
          <Select value={tagId} onValueChange={setTagId} required>
            <SelectTrigger id="editStepTag" className="mt-1.5">
              <SelectValue placeholder={tags?.length ? 'Select a tag…' : 'No tags yet — create one first'} />
            </SelectTrigger>
            <SelectContent>
              {(tags ?? []).map(tag => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </StepDialogShell>
  );
}
