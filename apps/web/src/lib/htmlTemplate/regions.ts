/**
 * Region inference and byte splicing for imported HTML email templates.
 *
 * The premise of the whole feature: an imported template is never re-serialized.
 * We parse it only to learn *where* the editable bits are, then write edits back by
 * splicing byte ranges into the original string. Everything the user did not edit
 * survives byte-for-byte — MSO conditional comments, VML fallbacks, unquoted
 * attributes, the exact whitespace a Stripo export happens to emit. A DOM
 * round-trip would quietly normalize all of it, pass every test anyone thinks to
 * write, and then break a mail client nobody can test.
 *
 * Deliberately DOM-free so it runs under the `plunk` vitest project, which is
 * `environment: 'node'` with no jsdom. Sanitization, which does need a DOM, lives
 * in `sanitize.ts`.
 */

import type {DefaultTreeAdapterMap} from 'parse5';
import {parse} from 'parse5';

import {REGION_ATTR, type BlockAlign, type EditableRegion, type RegionEdit} from './types';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/**
 * Element children a text region is allowed to contain. These are inline
 * formatting only: nothing here carries layout, so rewriting a region's inner
 * HTML cannot reflow the surrounding table structure.
 *
 * `img` is here because it is an inline replaced element, not a layout one. Real
 * templates put icons next to their labels — a social-links row is one cell of
 * `Follow us: <a><img> Instagram</a> …` — and excluding `img` froze that entire
 * row: the label text could not be edited at all. The image keeps its own region
 * regardless, so clicking the icon still swaps the image rather than typing over it.
 */
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'span', 'br', 'font', 'small', 'sub', 'sup', 'img']);

/**
 * Elements whose text content is not prose. Each holds a single text child and so
 * would otherwise pass the inline-only test — making a template's stylesheet
 * clickable and editable as rich text, which is exactly how you end up with a
 * `<b>` tag inside a `@media` block.
 */
const RAW_TEXT_TAGS = new Set(['style', 'script', 'title', 'textarea', 'noscript', 'template']);

/**
 * Text-region elements an alignment can be written to.
 *
 * `text-align` sets the alignment of an element's *inline children*, so it only
 * does anything on a block container — which is exactly what centring a button
 * needs, since the button itself is an `inline-block` `<a>` inside a `<p>` or a
 * `<td>`. Listing it out rather than excluding `INLINE_TAGS` keeps an unknown or
 * custom tag out: offering an alignment that silently does nothing is worse than
 * not offering one.
 *
 * A block tag also cannot host an image or link region inside its own start tag —
 * no `src`, no `href` — so a start-tag rewrite can never clobber another edit.
 */
const ALIGNABLE_TAGS = new Set([
  'p',
  'div',
  'td',
  'th',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'caption',
  'center',
]);

/** A Liquid tag that opens a block must close inside the same region, or editing
 *  that region's inner HTML would strand the other half of the pair. */
const BLOCK_OPENERS = ['if', 'unless', 'for', 'case', 'capture', 'tablerow', 'raw', 'comment'];

/**
 * True when every Liquid block tag in `text` opens and closes within it.
 * A region containing a dangling `{% if %}` is not editable: its `{% endif %}`
 * lives in a different element, and no edit to this region alone can keep the
 * pair intact.
 */
export function hasBalancedLiquidBlocks(text: string): boolean {
  const stack: string[] = [];

  for (const match of text.matchAll(/\{%-?\s*(\w+)/g)) {
    const tag = (match[1] ?? '').toLowerCase();

    if (BLOCK_OPENERS.includes(tag)) {
      stack.push(tag);
      continue;
    }

    if (tag.startsWith('end')) {
      const opener = tag.slice(3);
      // A close with nothing open, or closing the wrong block, both mean the
      // pair straddles this region's boundary.
      if (stack.pop() !== opener) return false;
    }
  }

  return stack.length === 0;
}

/**
 * Locates the value of `attr` within the element's source, excluding quotes.
 * parse5 gives the span of the whole `name="value"` pair, so the value is found
 * by stepping past the name and `=`. Returns null for a valueless attribute
 * (`<img src>`), which has no range to edit.
 */
function attrValueRange(html: string, span: {startOffset: number; endOffset: number}): {start: number; end: number} | null {
  const eq = html.indexOf('=', span.startOffset);
  if (eq === -1 || eq >= span.endOffset) return null;

  let start = eq + 1;
  while (start < span.endOffset && /\s/.test(html[start] ?? '')) start++;

  const quote = html[start];
  if (quote === '"' || quote === "'") {
    return {start: start + 1, end: span.endOffset - 1};
  }

  // Unquoted attribute value: runs to the end of the span parse5 reported.
  return start < span.endOffset ? {start, end: span.endOffset} : null;
}

interface ScannedAttr {
  /** Lowercased. */
  name: string;
  /** Range of the whole `name="value"` pair within the tag. */
  start: number;
  end: number;
  /** Range of the value with quotes excluded, or null for a valueless attribute. */
  valueStart: number | null;
  valueEnd: number | null;
  quoted: boolean;
  value: string;
}

/**
 * Splits a start tag into its attributes, offsets relative to the tag.
 *
 * Hand-written rather than a regex because the alternative — matching
 * `\sstyle\s*=\s*"[^"]*"` against the tag — also matches inside another
 * attribute's value, and `alt="see style=1"` would then be rewritten as if it
 * were the style attribute. Byte fidelity outside the one declaration being
 * changed is the promise this whole module rests on, so the scan is exact.
 *
 * parse5 is not used here: its attribute locations are relative to the whole
 * document, and the callers below hold a detached tag string.
 */
function scanStartTagAttrs(tag: string): ScannedAttr[] {
  const attrs: ScannedAttr[] = [];
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

  // Past `<` and the tag name.
  let i = 1;
  while (i < tag.length && !/[\s/>]/.test(tag[i] ?? '>')) i++;

  while (i < tag.length) {
    while (isSpace(tag[i])) i++;
    const c = tag[i];
    if (c === undefined || c === '>' || c === '/') break;

    const start = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i] ?? '>')) i++;
    const name = tag.slice(start, i).toLowerCase();

    let cursor = i;
    while (isSpace(tag[cursor])) cursor++;

    if (tag[cursor] !== '=') {
      attrs.push({name, start, end: i, valueStart: null, valueEnd: null, quoted: false, value: ''});
      continue;
    }

    cursor++;
    while (isSpace(tag[cursor])) cursor++;

    const quote = tag[cursor];
    if (quote === '"' || quote === "'") {
      const close = tag.indexOf(quote, cursor + 1);
      const valueEnd = close === -1 ? tag.length : close;
      attrs.push({
        name,
        start,
        end: Math.min(valueEnd + 1, tag.length),
        valueStart: cursor + 1,
        valueEnd,
        quoted: true,
        value: tag.slice(cursor + 1, valueEnd),
      });
      i = Math.min(valueEnd + 1, tag.length);
      continue;
    }

    const valueStart = cursor;
    while (cursor < tag.length && !/[\s>]/.test(tag[cursor] ?? '>')) cursor++;
    attrs.push({
      name,
      start,
      end: cursor,
      valueStart,
      valueEnd: cursor,
      quoted: false,
      value: tag.slice(valueStart, cursor),
    });
    i = cursor;
  }

  return attrs;
}

/** Replaces any `text-align` declaration with `align`, leaving every other
 *  declaration's original text untouched. */
function mergeTextAlign(style: string, align: BlockAlign): string {
  const kept = style
    .split(';')
    .filter(declaration => declaration.trim() !== '')
    .filter(declaration => {
      const colon = declaration.indexOf(':');
      return colon === -1 || declaration.slice(0, colon).trim().toLowerCase() !== 'text-align';
    });

  kept.push(` text-align: ${align}`);
  return `${kept.join(';').trim()};`;
}

/**
 * Rewrites a start tag so its content is aligned, preserving every other byte.
 *
 * The legacy `align` attribute is rewritten alongside the style rather than left
 * alone: Outlook's Word renderer honours it over `text-align`, so a tag that
 * carried `align="left"` would keep rendering left-aligned in the one client the
 * user is most likely to be checking against.
 */
export function setBlockAlign(startTag: string, align: BlockAlign): string {
  const attrs = scanStartTagAttrs(startTag);
  const splices: {start: number; end: number; text: string}[] = [];

  const legacy = attrs.find(a => a.name === 'align');
  if (legacy) {
    splices.push(
      legacy.valueStart !== null && legacy.valueEnd !== null && legacy.quoted
        ? {start: legacy.valueStart, end: legacy.valueEnd, text: align}
        : {start: legacy.start, end: legacy.end, text: `align="${align}"`},
    );
  }

  const style = attrs.find(a => a.name === 'style');
  if (style?.quoted && style.valueStart !== null && style.valueEnd !== null) {
    splices.push({start: style.valueStart, end: style.valueEnd, text: mergeTextAlign(style.value, align)});
  } else if (style) {
    // Unquoted or valueless: no value range to write into, so the pair is replaced.
    splices.push({start: style.start, end: style.end, text: `style="${mergeTextAlign(style.value, align)}"`});
  } else {
    // Inserted just past the last attribute, so a trailing `/>` or any spacing
    // before the `>` survives as authored.
    let insertAt = startTag.length - 1;
    while (insertAt > 0 && /[\s/]/.test(startTag[insertAt - 1] ?? '')) insertAt--;
    splices.push({start: insertAt, end: insertAt, text: ` style="text-align: ${align};"`});
  }

  let result = startTag;
  for (const splice of splices.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function childNodes(node: Node): Node[] {
  return 'childNodes' in node ? (node.childNodes as Node[]) : [];
}

/**
 * True when the subtree under `el` is text plus inline formatting only, and
 * contains at least one non-whitespace character. This is what makes a region
 * safe to edit as rich text: there is no layout inside it to destroy.
 */
function isInlineOnlyWithText(el: Element): boolean {
  let hasText = false;

  const walk = (node: Node): boolean => {
    for (const child of childNodes(node)) {
      if (isElement(child)) {
        if (!INLINE_TAGS.has(child.tagName)) return false;
        if (!walk(child)) return false;
      } else if (child.nodeName === '#text') {
        if ((child as {value: string}).value.trim() !== '') hasText = true;
      } else if (child.nodeName === '#comment') {
        // A conditional comment inside a text run would be dropped by an inner-HTML
        // rewrite, so the region is not editable.
        return false;
      }
    }
    return true;
  };

  return walk(el) && hasText;
}

/**
 * Finds every editable region in `html`.
 *
 * Text regions are emitted **outermost-first and never nested inside one another**:
 * for `<td><p>Hello <a>there</a></p></td>`, the region is the `<p>` — the `<td>`
 * is disqualified because `p` is not inline formatting, and the `<a>` is skipped
 * as a text region because its text is already editable through the `<p>`.
 *
 * Image and link regions are emitted for every `img` / `a[href]` regardless of
 * nesting: editing a link's URL is a separate affordance from editing the
 * sentence around it. `applyEdits` handles the resulting containment.
 */
export function inferEditableRegions(html: string): EditableRegion[] {
  const document = parse(html, {sourceCodeLocationInfo: true});
  const regions: EditableRegion[] = [];
  let nextId = 0;

  const markerOffset = (el: Element): number | null => {
    const loc = el.sourceCodeLocation;
    // Synthesized html/head/body wrappers have no location; so do elements inside
    // a malformed region parse5 could not place.
    if (!loc?.startTag) return null;
    return loc.startTag.startOffset + 1 + el.tagName.length;
  };

  const visit = (node: Node, insideTextRegion: boolean) => {
    if (isElement(node)) {
      const loc = node.sourceCodeLocation;
      const marker = markerOffset(node);

      if (marker !== null && loc) {
        if (node.tagName === 'img') {
          const span = loc.attrs?.src;
          const range = span ? attrValueRange(html, span) : null;
          if (range) {
            regions.push({
              id: `r${nextId++}`,
              kind: 'image',
              ...range,
              value: html.slice(range.start, range.end),
              markerAt: marker,
              tagName: 'img',
            });
          }
        }

        if (node.tagName === 'a') {
          const span = loc.attrs?.href;
          const range = span ? attrValueRange(html, span) : null;
          if (range) {
            regions.push({
              id: `r${nextId++}`,
              kind: 'link',
              ...range,
              value: html.slice(range.start, range.end),
              markerAt: marker,
              tagName: 'a',
            });
          }
        }

        // An element with no end tag has no inner range to splice into.
        if (!insideTextRegion && !RAW_TEXT_TAGS.has(node.tagName) && loc.startTag && loc.endTag && isInlineOnlyWithText(node)) {
          const start = loc.startTag.endOffset;
          const end = loc.endTag.startOffset;
          const value = html.slice(start, end);

          if (hasBalancedLiquidBlocks(value)) {
            regions.push({
              id: `r${nextId++}`,
              kind: 'text',
              start,
              end,
              value,
              markerAt: marker,
              tagName: node.tagName,
              ...(ALIGNABLE_TAGS.has(node.tagName)
                ? {
                    startTag: {
                      start: loc.startTag.startOffset,
                      end: loc.startTag.endOffset,
                      value: html.slice(loc.startTag.startOffset, loc.startTag.endOffset),
                    },
                  }
                : {}),
            });
            insideTextRegion = true;
          }
        }
      }
    }

    for (const child of childNodes(node)) visit(child, insideTextRegion);
  };

  visit(document, false);

  return regions.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Writes `edits` back into `html` by splicing byte ranges, applied back-to-front
 * so that earlier offsets stay valid as later ones are replaced.
 *
 * **Nested edits collapse rather than conflict.** `<p>Read <a href="x">this</a></p>`
 * produces a text region for the `<p>` and a link region for the `<a>` inside it —
 * the ordinary shape of any styled button or in-sentence link. If both are edited,
 * the text region's new value *is* the serialized inner content and therefore
 * already carries the new href, so the nested edit is dropped rather than applied
 * twice. The throw is reserved for ranges that partially cross, which inference
 * cannot produce and which would mean a caller fabricated offsets.
 *
 * **A `startTag` edit is not a nested edit.** It writes the element's own tag,
 * which is adjacent to that element's inner range rather than inside it, so
 * aligning a paragraph and retyping it are two independent splices that both
 * apply — the collapse above would be wrong for them, and is asserted against.
 *
 * Every edit carries `previous`, the bytes it was inferred against, and is
 * verified before anything is written. Ids are positional, so a source that
 * changed underneath the caller would otherwise reuse an id for a different
 * element and splice inner HTML into an attribute without complaint.
 */
export function applyEdits(html: string, edits: RegionEdit[]): string {
  if (edits.length === 0) return html;

  const seen = new Set<string>();
  for (const edit of edits) {
    // Keyed on the range, not the region: aligning a button and retitling it are
    // two edits on the same id, and both must apply.
    const key = `${edit.id}:${edit.target ?? 'value'}`;
    if (seen.has(key)) {
      // Two values for one range: whichever we applied would be arbitrary.
      throw new Error(`Region "${edit.id}" was edited twice in one batch.`);
    }
    seen.add(key);
  }

  const byId = new Map(inferEditableRegions(html).map(r => [r.id, r]));

  const pending = edits.map(edit => {
    const region = byId.get(edit.id);
    if (!region) {
      throw new Error(`Unknown region "${edit.id}" — the source changed since regions were inferred.`);
    }

    const isStartTag = edit.target === 'startTag';
    const range = isStartTag ? region.startTag : region;
    if (!range) {
      throw new Error(`Region "${edit.id}" has no start tag to edit.`);
    }
    if (range.value !== edit.previous) {
      throw new Error(
        `Region "${edit.id}" no longer holds the content it was inferred against; the source changed underneath this edit.`,
      );
    }

    return {region, isStartTag, start: range.start, end: range.end, value: edit.value};
  });

  // Outermost first, so a containing text region is seen before what it contains.
  pending.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted: typeof pending = [];

  for (const candidate of pending) {
    const enclosing = accepted.find(a => a.start <= candidate.start && candidate.end <= a.end);

    if (enclosing) {
      // A start tag sits outside its own region's range and outside every other
      // region's, so neither side of a containment can be one. Asserted rather
      // than handled: an enclosed start-tag edit would be dropped as superseded
      // by a value that does not contain it.
      if (enclosing.isStartTag || candidate.isStartTag) {
        throw new Error(`Region "${candidate.region.id}" overlaps the start tag of "${enclosing.region.id}".`);
      }
      // Contained in an already-accepted edit whose new value supersedes it.
      if (enclosing.region.kind !== 'text') {
        throw new Error(`Region "${candidate.region.id}" is nested inside non-text region "${enclosing.region.id}".`);
      }
      continue;
    }

    const crossing = accepted.find(a => candidate.start < a.end && a.start < candidate.end);
    if (crossing) {
      throw new Error(`Region "${candidate.region.id}" partially overlaps "${crossing.region.id}"; edits cannot be applied.`);
    }

    accepted.push(candidate);
  }

  let result = html;
  for (const {start, end, value} of [...accepted].reverse()) {
    result = result.slice(0, start) + value + result.slice(end);
  }

  return result;
}

/**
 * Injects the marker attributes the rendered copy is clicked through, without
 * disturbing any other byte. Markers are injected attributes rather than
 * positional paths into the parse5 tree on purpose: the browser re-parses what it
 * is handed and need not agree with parse5's tree shape, and sanitization removes
 * nodes — either would desync a path. What is *stored* is always the original.
 *
 * The returned string is for RENDERING ONLY and must never be fed back to
 * `applyEdits`: inserting the markers shifts every offset after the first one, so
 * the regions passed in no longer describe it. Keep the original string as the
 * edit target and this one as the display copy.
 */
export function injectRegionMarkers(html: string, regions: EditableRegion[]): string {
  // Back-to-front, and later-inserted markers first at a shared offset, so every
  // offset stays valid as we go.
  const ordered = [...regions].sort((a, b) => b.markerAt - a.markerAt);

  let result = html;
  for (const region of ordered) {
    const attr = ` ${REGION_ATTR[region.kind]}="${region.id}"`;
    result = result.slice(0, region.markerAt) + attr + result.slice(region.markerAt);
  }

  return result;
}
