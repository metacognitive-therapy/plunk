/**
 * The parse5-free half of the module.
 *
 * Everything here is safe to import from ordinary component code. `regions.ts`
 * pulls in parse5 (~424K of CJS) and must only ever be reached through a dynamic
 * `import('./regions')` from the editor, so that it lands in the editor's chunk
 * rather than the shared bundle. That is why these constants and types live apart
 * from the functions that use them, and why the barrel does not re-export
 * `regions.ts`.
 */

export type RegionKind = 'text' | 'image' | 'link';

/** The attribute each kind is marked with at render time. Distinct names so one
 *  element can host both a text and a link region without them colliding. */
export const REGION_ATTR: Record<RegionKind, string> = {
  text: 'data-plunk-text',
  image: 'data-plunk-image',
  link: 'data-plunk-link',
};

/** Horizontal alignments a block region can be set to. */
export type BlockAlign = 'left' | 'center' | 'right';

/**
 * The element's whole start tag, `<` through `>`, in the original source.
 *
 * Alignment is the one edit that cannot be written into a region's own range:
 * centring a button means `text-align: center` on the *container*, and a text
 * region's range is its inner content. The range recorded here is adjacent to
 * that inner range rather than inside it (`startTag.end === region.start`), so
 * the two never overlap and both apply — unlike a nested href edit, which the
 * enclosing text region's new value already carries and `applyEdits` collapses.
 *
 * The whole tag rather than an insertion point on purpose: a zero-width range
 * would make `previous` the empty string, identical for every unstyled element,
 * and the stale-id guard would be vacuous exactly where it is needed. Rewriting
 * the whole tag also makes the inline style and the legacy `align` attribute one
 * serialization, so they cannot disagree.
 */
export interface StartTagRange {
  start: number;
  end: number;
  /** The tag source, verbatim. */
  value: string;
}

export interface EditableRegion {
  id: string;
  kind: RegionKind;
  /** Byte range in the ORIGINAL html that an edit to this region replaces. For a
   *  text region this is the inner content; for image/link it is the bare
   *  attribute value, quotes excluded. */
  start: number;
  end: number;
  /** Current content of that range, verbatim. */
  value: string;
  /** Offset just past the element's tag name, where the marker attribute is
   *  injected for rendering. */
  markerAt: number;
  /** Lowercased tag name of the element the region belongs to. */
  tagName: string;
  /** Present only on text regions whose element is block-level, which are the
   *  only ones an alignment can be written to. Inline elements are excluded
   *  because `text-align` on them is a no-op. */
  startTag?: StartTagRange;
}

export interface RegionEdit {
  id: string;
  /**
   * Which of the region's two ranges this edit replaces. Omitted for an ordinary
   * content edit; `'startTag'` for one that rewrites the element's own tag.
   */
  target?: 'startTag';
  /** Replacement for the targeted byte range: inner HTML for a text region, a
   *  bare URL for image/link, the whole tag for a `startTag` edit. */
  value: string;
  /**
   * The targeted range's content at the time it was inferred — the region's
   * `value`, or the start tag's for a `startTag` edit.
   *
   * Region ids are positional (`r0..rN` in traversal order), so if the source
   * gains or loses a region between inference and apply — a paste in the Code
   * view, a `value` change from the parent — an id survives but comes to mean a
   * *different* element, possibly of a different kind. Splicing then writes inner
   * HTML into an `href` and reports success. Carrying the original bytes turns
   * every such case into a loud failure instead of silent corruption.
   */
  previous: string;
}
