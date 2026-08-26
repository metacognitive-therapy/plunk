import {Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import {Bold, Italic, Link2, Monitor, Smartphone, Tablet, Underline} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';

import {detectCustomHtmlPatterns, wrapEmailBody} from '../../lib/emailStyles';
import {REGION_ATTR, stripRegionMarkers, sanitizeForRender, type EditableRegion, type RegionEdit} from '../../lib/htmlTemplate';
import {network} from '../../lib/network';
import {DEVICE_WIDTHS, DEVICES, type PreviewDevice} from './PreviewPane';

/**
 * Styling for the editing affordances. Injected into the iframe as a separate
 * stylesheet rather than concatenated into the template, so it can never end up
 * in the stored bytes. Scoped entirely to the marker attributes, which only exist
 * on the render copy.
 */
const EDIT_STYLES = `
[${REGION_ATTR.text}], [${REGION_ATTR.image}] { outline: 1px dashed transparent; outline-offset: 2px; cursor: text; transition: outline-color .12s; }
[${REGION_ATTR.image}] { cursor: pointer; }
[${REGION_ATTR.text}]:hover, [${REGION_ATTR.image}]:hover { outline-color: #93c5fd; }
[contenteditable="true"] { outline: 2px solid #2563eb !important; outline-offset: 2px; }
`;

interface ActiveEdit {
  region: EditableRegion;
  element: HTMLElement;
  /**
   * The element's stripped `innerHTML` as the browser serialized it at focus time —
   * NOT `region.value`. The browser normalizes on serialize (`&mdash;` becomes an
   * em dash, attribute quoting changes), so comparing against the parse5-derived
   * original would mark every merely-clicked element dirty and rewrite the whole
   * template in browser dialect.
   */
  baseline: string;
  /** A href change made through the toolbar while this element was focused. */
  hrefEdit: RegionEdit | null;
}

interface EditablePaneProps {
  /** The stored original, unsubstituted. The only edit target. */
  html: string;
  /** Receives the full template with the edited byte ranges spliced in. */
  onChange: (html: string) => void;
  device: PreviewDevice;
  onDeviceChange: (device: PreviewDevice) => void;
}

/**
 * Click-to-edit over the rendered template.
 *
 * Deliberately not a variant of `PreviewPane`: this iframe is written on mount and
 * on external source change only. Rewriting it mid-edit would destroy the caret,
 * which is why every commit happens on blur — by then focus has already left, so
 * re-rendering with freshly inferred regions costs nothing.
 *
 * Three strings, never conflated: the *original* (`html`) is inferred against and
 * spliced into; the *marked* copy carries the region attributes and has shifted
 * offsets, so it must never reach `applyEdits`; the *sanitized* copy is what the
 * iframe sees.
 */
export function EditablePane({html, onChange, device, onDeviceChange}: EditablePaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Read inside iframe event handlers, which outlive the render that created them.
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const regionsRef = useRef<Map<string, EditableRegion>>(new Map());
  const activeRef = useRef<ActiveEdit | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [toolbar, setToolbar] = useState<{top: number; left: number; hasLink: boolean} | null>(null);
  const [imageTarget, setImageTarget] = useState<{regionId: string; previous: string} | null>(null);
  const [linkTarget, setLinkTarget] = useState<{regionId: string; previous: string; anchor: HTMLElement} | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Splices one batch into the original and hands it up. */
  const applyRegionEdits = useCallback(async (edits: RegionEdit[]) => {
    if (edits.length === 0) return;
    const {applyEdits} = await import('../../lib/htmlTemplate/regions');
    try {
      onChangeRef.current(applyEdits(htmlRef.current, edits));
      setError(null);
    } catch (cause) {
      // Every throw from applyEdits means the source moved underneath this edit.
      // Refusing to splice is the point: the alternative is silent corruption.
      setError(cause instanceof Error ? cause.message : 'That edit could not be applied.');
    }
  }, []);

  /** Ends the active editing session, committing only if the content actually changed. */
  const commitActive = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;

    active.element.contentEditable = 'false';
    setToolbar(null);

    const edits: RegionEdit[] = [];
    const value = stripRegionMarkers(active.element.innerHTML);
    if (value !== active.baseline) {
      edits.push({id: active.region.id, value, previous: active.region.value});
    }
    // Kept separate from the text edit: when the anchor is nested inside the text
    // region the new innerHTML already carries the href and `applyEdits` collapses
    // this away, but when the anchor *is* the text region its href sits outside
    // that range and only this edit writes it.
    if (active.hrefEdit) edits.push(active.hrefEdit);

    void applyRegionEdits(edits);
  }, [applyRegionEdits]);

  const positionToolbar = useCallback((element: HTMLElement, hasLink: boolean) => {
    const iframe = iframeRef.current;
    const wrapper = wrapperRef.current;
    if (!iframe || !wrapper) return;

    const rect = element.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    setToolbar({
      top: iframeRect.top - wrapperRect.top + rect.top - 44,
      left: iframeRect.left - wrapperRect.left + rect.left,
      hasLink,
    });
  }, []);

  // Renders the template into the iframe and wires click routing. Keyed on `html`
  // alone: after a commit the parent hands back the spliced source and everything
  // is re-inferred against it, so region ids never go stale against the DOM.
  useEffect(() => {
    let cancelled = false;
    // The render is async (parse5 is dynamically imported), so the effect returns
    // before there is anything to tear down. Listeners register themselves here.
    let teardown: (() => void) | null = null;
    const iframe = iframeRef.current;
    if (!iframe) return;

    void (async () => {
      const {inferEditableRegions, injectRegionMarkers} = await import('../../lib/htmlTemplate/regions');
      if (cancelled) return;

      const regions = inferEditableRegions(html);
      regionsRef.current = new Map(regions.map(r => [r.id, r]));

      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;

      // The wrap decision is made against the *original*: the marked copy's injected
      // `data-plunk-*` attributes would otherwise read as authored custom HTML and
      // suppress the wrapper for a template that needs it.
      const marked = injectRegionMarkers(html, regions);
      const rendered = detectCustomHtmlPatterns(html) ? marked : wrapEmailBody(marked);

      doc.open();
      doc.write(sanitizeForRender(rendered));
      doc.close();

      const style = doc.createElement('style');
      style.textContent = EDIT_STYLES;
      doc.head?.appendChild(style);

      const adjustHeight = () => {
        if (!iframe.contentWindow) return;
        iframe.style.height = '0px';
        const height = Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0);
        iframe.style.height = `${Math.max(400, height + 40)}px`;
      };
      const timeouts = [window.setTimeout(adjustHeight, 100), window.setTimeout(adjustHeight, 300)];

      const onClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;

        // Anchors would navigate the iframe away from the template.
        const anchor = target.closest('a');
        if (anchor) event.preventDefault();

        const image = target.closest<HTMLElement>(`[${REGION_ATTR.image}]`);
        if (image) {
          const id = image.getAttribute(REGION_ATTR.image);
          const region = id ? regionsRef.current.get(id) : undefined;
          if (region) {
            commitActive();
            setImageUrl(region.value);
            setImageFile(null);
            setImageTarget({regionId: region.id, previous: region.value});
          }
          return;
        }

        const text = target.closest<HTMLElement>(`[${REGION_ATTR.text}]`);
        if (!text) {
          commitActive();
          return;
        }
        if (activeRef.current?.element === text) {
          positionToolbar(text, Boolean(text.closest('a') ?? text.querySelector('a')));
          return;
        }

        commitActive();

        const id = text.getAttribute(REGION_ATTR.text);
        const region = id ? regionsRef.current.get(id) : undefined;
        if (!region) return;

        text.contentEditable = 'true';
        text.focus();
        activeRef.current = {region, element: text, baseline: stripRegionMarkers(text.innerHTML), hrefEdit: null};
        positionToolbar(text, Boolean(text.closest('a') ?? text.querySelector('a')));
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') commitActive();
      };

      const onScroll = () => {
        const active = activeRef.current;
        if (active) positionToolbar(active.element, Boolean(active.element.querySelector('a')));
      };

      doc.addEventListener('click', onClick, true);
      doc.addEventListener('keydown', onKeyDown);
      const view = iframe.contentWindow;
      view?.addEventListener('scroll', onScroll);

      teardown = () => {
        timeouts.forEach(window.clearTimeout);
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('keydown', onKeyDown);
        view?.removeEventListener('scroll', onScroll);
      };
      // Unmounted while parse5 was loading: nothing rendered, but tear down anyway.
      if (cancelled) teardown();
    })();

    return () => {
      cancelled = true;
      activeRef.current = null;
      setToolbar(null);
      teardown?.();
    };
  }, [html, device, commitActive, positionToolbar]);

  const exec = (command: string) => {
    const doc = iframeRef.current?.contentDocument;
    // execCommand is deprecated but is what keeps a region's existing inline
    // markup (`<font>`, `<span style>`) closest to as-authored; a rich-text engine
    // mounted per element would normalize it on every edit.
    doc?.execCommand(command);
    activeRef.current?.element.focus();
  };

  /** Opens the URL field for whichever anchor the caret currently sits in. */
  const openLinkDialog = () => {
    const active = activeRef.current;
    if (!active) return;

    const doc = iframeRef.current?.contentDocument;
    const selectionAnchor = doc?.getSelection()?.anchorNode as Node | null;
    const fromSelection =
      selectionAnchor instanceof HTMLElement
        ? selectionAnchor.closest('a')
        : (selectionAnchor?.parentElement?.closest('a') ?? null);
    const anchor = fromSelection || (active.element.tagName === 'A' ? active.element : active.element.querySelector('a'));
    if (!anchor) return;

    const id = anchor.getAttribute(REGION_ATTR.link);
    const region = id ? regionsRef.current.get(id) : undefined;
    if (!region) return;

    setLinkTarget({regionId: region.id, previous: region.value, anchor: anchor as HTMLElement});
    setLinkUrl(anchor.getAttribute('href') ?? '');
  };

  const submitLink = () => {
    const target = linkTarget;
    const active = activeRef.current;
    if (!target) return;

    // Written to the live DOM as well as recorded: when the anchor is nested inside
    // the active text region, it is the DOM change that the text commit carries.
    target.anchor.setAttribute('href', linkUrl);
    const edit: RegionEdit = {id: target.regionId, value: linkUrl, previous: target.previous};

    if (active) {
      active.hrefEdit = edit;
    } else {
      void applyRegionEdits([edit]);
    }
    setLinkTarget(null);
  };

  const submitImage = async () => {
    if (!imageTarget) return;
    let src = imageUrl;

    if (imageFile) {
      try {
        const formData = new FormData();
        formData.append('image', imageFile);
        const response = await network.upload<{url: string; key: string}>('POST', '/uploads/image', formData);
        src = response.url;
      } catch {
        setError('Couldn’t upload the image. Try again.');
        return;
      }
    }
    if (!src) return;

    await applyRegionEdits([{id: imageTarget.regionId, value: src, previous: imageTarget.previous}]);
    setImageTarget(null);
    setImageFile(null);
    setImageUrl('');
  };

  return (
    <>
      <div className="border-t border-neutral-200 bg-neutral-100 px-4 py-2 lg:border-t-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-neutral-600">Click any text or image to edit it</p>
            <span className="text-xs text-neutral-500">· variables not filled in</span>
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

      {error && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {error} Reopen this editor to pick up the current version of the template.
        </div>
      )}

      <div ref={wrapperRef} className="relative p-4 bg-neutral-50 flex justify-center items-start overflow-auto min-h-[400px]">
        {toolbar && (
          <div
            className="absolute z-20 flex gap-1 rounded-md border border-neutral-300 bg-white p-1 shadow-lg"
            style={{top: toolbar.top, left: toolbar.left}}
            // Keeping focus in the iframe is what preserves the selection the
            // command applies to.
            onMouseDown={event => event.preventDefault()}
          >
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title="Bold" onClick={() => exec('bold')}>
              <Bold className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title="Italic" onClick={() => exec('italic')}>
              <Italic className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Underline"
              onClick={() => exec('underline')}
            >
              <Underline className="h-3.5 w-3.5" />
            </Button>
            {toolbar.hasLink && (
              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title="Edit link" onClick={openLinkDialog}>
                <Link2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={commitActive}>
              Done
            </Button>
          </div>
        )}

        <div className="transition-all duration-300" style={{width: DEVICE_WIDTHS[device], maxWidth: '100%'}}>
          <div className="bg-white rounded-lg border border-neutral-300 shadow-lg overflow-hidden">
            <iframe ref={iframeRef} className="w-full border-0" style={{minHeight: '400px', height: '100%'}} title="Email editor" />
          </div>
        </div>
      </div>

      <Dialog open={Boolean(linkTarget)} onOpenChange={open => !open && setLinkTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit link</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="editable-link-url">Destination</Label>
              <Input
                id="editable-link-url"
                value={linkUrl}
                onChange={event => setLinkUrl(event.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setLinkTarget(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={submitLink}>
                Save link
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(imageTarget)} onOpenChange={open => !open && setImageTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="editable-image-url">Image URL</Label>
              <Input
                id="editable-image-url"
                value={imageUrl}
                onChange={event => setImageUrl(event.target.value)}
                placeholder="https://…"
              />
            </div>
            <div>
              <Label htmlFor="editable-image-file">Or upload a file</Label>
              <Input
                id="editable-image-file"
                type="file"
                accept="image/*"
                onChange={event => setImageFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setImageTarget(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submitImage()}>
                Replace
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
