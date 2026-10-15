import {formatFileSize, isInlineImage} from '@plunk/shared';
import type {ChatAttachment, ChatAttachmentLink} from '@plunk/types';
import {FileText} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {network} from '../../lib/network';

/* Links expire after a few minutes, so each image and each download asks for a fresh one rather
than reusing a URL that may have lapsed while the thread was open. */
function useAttachmentLink(conversationId: string, attachmentId: string) {
  return useCallback(async () => {
    const res = await network.fetch<{data: ChatAttachmentLink}>(
      'GET',
      `/conversations/${conversationId}/attachments/${attachmentId}`,
    );
    return res.data.url;
  }, [conversationId, attachmentId]);
}

export function MessageAttachments({
  conversationId,
  attachments,
  align,
}: {
  conversationId: string;
  attachments: ChatAttachment[];
  align: 'start' | 'end';
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={`flex max-w-[75%] flex-col gap-1.5 ${align === 'end' ? 'items-end' : 'items-start'}`}>
      {attachments.map(attachment =>
        isInlineImage(attachment.contentType) ? (
          <ImageAttachment key={attachment.id} conversationId={conversationId} attachment={attachment} />
        ) : (
          <FileAttachment key={attachment.id} conversationId={conversationId} attachment={attachment} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({conversationId, attachment}: {conversationId: string; attachment: ChatAttachment}) {
  const link = useAttachmentLink(conversationId, attachment.id);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);

  useEffect(() => {
    link()
      .then(setSrc)
      .catch(() => setFailed(true));
  }, [link]);

  if (failed) {
    return <FileAttachment conversationId={conversationId} attachment={attachment} />;
  }

  return (
    <button
      type="button"
      title={attachment.filename}
      onClick={() => {
        void link()
          .then(url => window.open(url, '_blank', 'noopener,noreferrer'))
          .catch(() => toast.error('Couldn’t open the image.'));
      }}
      className="block cursor-zoom-in overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={attachment.filename}
          className="block max-h-64 max-w-full object-contain"
          onError={() => {
            if (retried.current) {
              setFailed(true);
              return;
            }
            retried.current = true;
            link()
              .then(setSrc)
              .catch(() => setFailed(true));
          }}
        />
      ) : (
        <span className="block h-32 w-48 animate-pulse" aria-busy="true" />
      )}
    </button>
  );
}

function FileAttachment({conversationId, attachment}: {conversationId: string; attachment: ChatAttachment}) {
  const link = useAttachmentLink(conversationId, attachment.id);
  return (
    <button
      type="button"
      onClick={() => {
        void link()
          .then(url => window.location.assign(url))
          .catch(() => toast.error('Couldn’t download the file.'));
      }}
      aria-label={`Download ${attachment.filename}`}
      className="flex max-w-full items-center gap-2.5 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-left text-sm text-neutral-900 hover:bg-neutral-50"
    >
      <FileText className="h-5 w-5 shrink-0 text-neutral-500" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{attachment.filename}</span>
        <span className="block text-xs text-neutral-500">{formatFileSize(attachment.size)}</span>
      </span>
    </button>
  );
}
