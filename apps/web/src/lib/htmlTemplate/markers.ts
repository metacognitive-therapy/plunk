import {REGION_ATTR} from './types';

const MARKER_PATTERN = new RegExp(`\\s(?:${Object.values(REGION_ATTR).join('|')})="[^"]*"`, 'g');

/**
 * Removes every region marker from a fragment of rendered HTML.
 *
 * Markers are injected just past a tag name, which for a *nested* region — a link
 * or image inside an editable paragraph — puts them inside the enclosing text
 * region's inner content. Serializing that paragraph to commit an edit would
 * otherwise splice `data-plunk-link="r4"` into the stored template, where the next
 * inference reads it as an ordinary authored attribute and the next edit adds
 * another. Every value read out of the rendered DOM passes through here first.
 */
export function stripRegionMarkers(html: string): string {
  return html.replace(MARKER_PATTERN, '');
}
