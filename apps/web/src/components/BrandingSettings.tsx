import {zodResolver} from '@hookform/resolvers/zod';
import type {Project} from '@plunk/db';
import {NEUTRAL_BRAND_NAME, ProjectSchemas, resolveBrand} from '@plunk/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '@plunk/ui';
import {Upload} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {useForm} from 'react-hook-form';
import {toast} from 'sonner';
import {z} from 'zod';

import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {useConfig} from '../lib/hooks/useConfig';
import {useProjects} from '../lib/hooks/useProject';
import {network} from '../lib/network';
import {BrandMark} from './BrandMark';

const brandingSchema = z.object({
  brandName: z.union([ProjectSchemas.update.shape.brandName.unwrap().unwrap(), z.literal('')]),
  brandLogoUrl: z.union([ProjectSchemas.update.shape.brandLogoUrl.unwrap().unwrap(), z.literal('')]),
});

type BrandingValues = z.infer<typeof brandingSchema>;

interface BrandingSettingsProps {
  canEdit: boolean;
}

export function BrandingSettings({canEdit}: BrandingSettingsProps) {
  const {activeProject, updateActiveProject} = useActiveProject();
  const {mutate: projectsMutate} = useProjects();
  const {data: config} = useConfig();
  const s3Enabled = config?.features.storage.s3Enabled ?? false;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const form = useForm<BrandingValues>({
    resolver: zodResolver(brandingSchema),
    defaultValues: {brandName: '', brandLogoUrl: ''},
  });

  useEffect(() => {
    if (activeProject) {
      form.reset({brandName: activeProject.brandName ?? '', brandLogoUrl: activeProject.brandLogoUrl ?? ''});
    }
  }, [activeProject, form]);

  const preview = resolveBrand(form.watch());

  const handleFile = async (file: File) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const response = await network.upload<{url: string}>('POST', '/uploads/image', formData);
      form.setValue('brandLogoUrl', response.url, {shouldDirty: true, shouldValidate: true});
    } catch {
      toast.error('Couldn’t upload the logo. Try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const onSubmit = async (values: BrandingValues) => {
    if (!activeProject) return;
    try {
      const updated = await network.fetch<Project, typeof ProjectSchemas.update>(
        'PATCH',
        `/users/@me/projects/${activeProject.id}`,
        {brandName: values.brandName || null, brandLogoUrl: values.brandLogoUrl || null},
      );
      updateActiveProject(updated);
      await projectsMutate();
      toast.success('Branding saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the branding. Try again.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>
          The name and logo shown in the sidebar and in this project&apos;s emails. Leave both empty to use the
          neutral &ldquo;{NEUTRAL_BRAND_NAME}&rdquo; brand.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="brandName"
              render={({field}) => (
                <FormItem>
                  <FormLabel>Brand name</FormLabel>
                  <FormControl>
                    <Input placeholder={NEUTRAL_BRAND_NAME} disabled={!canEdit} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="brandLogoUrl"
              render={({field}) => (
                <FormItem>
                  <FormLabel>Logo</FormLabel>
                  <div className="flex gap-2">
                    <FormControl>
                      <Input placeholder="https://…/logo.png" disabled={!canEdit} {...field} />
                    </FormControl>
                    {s3Enabled && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) void handleFile(file);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!canEdit || isUploading}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="h-4 w-4" />
                          {isUploading ? 'Uploading…' : 'Upload'}
                        </Button>
                      </>
                    )}
                  </div>
                  <FormDescription>
                    A square PNG or JPG, at least 128px. Emails load it from this URL, so it must be publicly
                    reachable.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
              <p className="text-xs font-medium text-neutral-500 mb-2">Preview</p>
              <BrandMark brand={preview} />
            </div>

            {canEdit && (
              <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                {form.formState.isSubmitting ? 'Saving…' : 'Save branding'}
              </Button>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
