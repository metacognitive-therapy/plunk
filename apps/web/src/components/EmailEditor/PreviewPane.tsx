import {Button} from '@plunk/ui';
import {Monitor, Smartphone, Tablet} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';

import {wrapEmailWithStyles} from '../../lib/emailStyles';

export type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

export const DEVICE_WIDTHS: Record<PreviewDevice, string> = {
  mobile: '375px',
  tablet: '768px',
  desktop: '1200px', // Standard desktop email width
};

export const DEVICES: {id: PreviewDevice; icon: typeof Monitor; label: string}[] = [
  {id: 'mobile', icon: Smartphone, label: 'Mobile'},
  {id: 'tablet', icon: Tablet, label: 'Tablet'},
  {id: 'desktop', icon: Monitor, label: 'Desktop'},
];

interface PreviewPaneProps {
  /** Already substituted against the selected contact, if any. */
  html: string;
  /** Already substituted. Omitted along with from/replyTo when there is nothing to show. */
  subject?: string;
  from?: string;
  replyTo?: string;
  device: PreviewDevice;
  onDeviceChange: (device: PreviewDevice) => void;
  /**
   * False when no contact is selected, in which case `html` still contains its
   * `{{ ... }}` / `{% ... %}` source. Says so in the header, so literal variable
   * text doesn't read as a rendering bug.
   */
  substituted: boolean;
}

/**
 * The read-only rendering of the email. Deliberately unconditional: a project with
 * no contacts still needs to see what it is designing, so with no contact selected
 * the caller passes the raw template through and it renders unsubstituted.
 */
export function PreviewPane({html, subject, from, replyTo, device, onDeviceChange, substituted}: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Rewriting the whole iframe document on every keystroke is visible work on a
  // large template (a Stripo export is tens of KB of tables). The editor stays
  // responsive because the write is what waits, not the typing.
  const [debouncedHtml, setDebouncedHtml] = useState(html);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedHtml(html), 250);
    return () => window.clearTimeout(id);
  }, [html]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) return;

    iframeDoc.open();
    iframeDoc.write(wrapEmailWithStyles(debouncedHtml));
    iframeDoc.close();

    // Auto-adjust iframe height to content. Reset to a small value first so
    // body content that uses % / vh heights doesn't lock the iframe to its
    // previous size (which would otherwise cause the iframe to grow by the
    // padding offset on every preview-device switch).
    const adjustHeight = () => {
      if (!iframe.contentWindow) return;
      iframe.style.height = '0px';
      const doc = iframe.contentWindow.document;
      const height = Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0);
      iframe.style.height = `${Math.max(400, height + 40)}px`;
    };

    const timeouts = [window.setTimeout(adjustHeight, 100), window.setTimeout(adjustHeight, 300)];
    iframe.contentWindow?.addEventListener('load', adjustHeight);

    return () => {
      timeouts.forEach(window.clearTimeout);
      iframe.contentWindow?.removeEventListener('load', adjustHeight);
    };
  }, [debouncedHtml, device]);

  return (
    <>
      <div className="border-t border-neutral-200 bg-neutral-100 px-4 py-2 lg:border-t-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-neutral-600">Preview</p>
            <span className="text-xs text-neutral-500">({DEVICE_WIDTHS[device]})</span>
            {!substituted && <span className="text-xs text-neutral-500">· variables not filled in</span>}
          </div>
          <div className="flex gap-1">
            {DEVICES.map(({id, icon: Icon, label}) => (
              <Button
                key={id}
                type="button"
                variant={device === id ? 'default' : 'ghost'}
                size="sm"
                onClick={() => onDeviceChange(id)}
                className="h-7 w-7 p-0"
                title={`${label} (${DEVICE_WIDTHS[id]})`}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="p-4 bg-neutral-50 flex justify-center items-start overflow-auto min-h-[400px]">
        <div className="transition-all duration-300" style={{width: DEVICE_WIDTHS[device], maxWidth: '100%'}}>
          <div className="bg-white rounded-lg border border-neutral-300 shadow-lg overflow-hidden">
            {(subject || from || replyTo) && (
              <div className="bg-neutral-50 border-b border-neutral-200 p-4 space-y-2">
                {subject && (
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-xs text-neutral-500 uppercase tracking-wide font-medium">Subject</p>
                      <p className="text-base font-semibold text-neutral-900 mt-1">{subject}</p>
                    </div>
                  </div>
                )}
                {(from || replyTo) && (
                  <div className="flex gap-6 pt-2 border-t border-neutral-200">
                    {from && (
                      <div>
                        <p className="text-xs text-neutral-500">From</p>
                        <p className="text-sm text-neutral-900 mt-0.5">{from}</p>
                      </div>
                    )}
                    {replyTo && (
                      <div>
                        <p className="text-xs text-neutral-500">Reply-To</p>
                        <p className="text-sm text-neutral-900 mt-0.5">{replyTo}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              className="w-full border-0"
              style={{minHeight: '400px', height: '100%'}}
              title="Email preview"
            />
          </div>
        </div>
      </div>
    </>
  );
}
