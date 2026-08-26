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
}

export interface RegionEdit {
  id: string;
  /** Replacement for the region's byte range: inner HTML for a text region, a
   *  bare URL for image/link. */
  value: string;
  /**
   * The region's `value` at the time it was inferred.
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
