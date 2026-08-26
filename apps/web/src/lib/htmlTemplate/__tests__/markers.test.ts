import {describe, expect, it} from 'vitest';

import {stripRegionMarkers} from '../markers';
import {applyEdits, inferEditableRegions, injectRegionMarkers} from '../regions';

describe('stripRegionMarkers', () => {
  it('removes every marker kind', () => {
    const html = '<p data-plunk-text="r0">Hi <a data-plunk-link="r1" href="x">there</a> <img data-plunk-image="r2" src="y"></p>';

    expect(stripRegionMarkers(html)).toBe('<p>Hi <a href="x">there</a> <img src="y"></p>');
  });

  it('leaves other data attributes alone', () => {
    const html = '<div data-plunk-text="r0" data-stripo-id="abc" data-plunkish="no">x</div>';

    expect(stripRegionMarkers(html)).toBe('<div data-stripo-id="abc" data-plunkish="no">x</div>');
  });

  it('is a no-op on markup that was never marked', () => {
    const html = '<td class="col"><p>Plain</p></td>';

    expect(stripRegionMarkers(html)).toBe(html);
  });
});

describe('the render-then-commit round trip', () => {
  /**
   * The corruption this guards against: a marker injected on a *nested* link sits
   * inside the enclosing text region's inner content, so committing the paragraph
   * would splice `data-plunk-link="r4"` into the stored template — where the next
   * inference reads it as an authored attribute and the next edit adds another.
   */
  it('never writes a marker into the stored bytes', () => {
    const original = '<p>Hi there &mdash; read <a href="https://example.com/guide">the guide</a> first.</p>';
    const regions = inferEditableRegions(original);
    const paragraph = regions.find(r => r.kind === 'text' && r.tagName === 'p');
    expect(paragraph).toBeDefined();

    // What the browser would hand back from `innerHTML` after the user edited the
    // rendered copy: the markers are still on the nested nodes.
    const marked = injectRegionMarkers(original, regions);
    const innerStart = marked.indexOf('>', marked.indexOf('<p')) + 1;
    const rendered = marked.slice(innerStart, marked.indexOf('</p>'));
    expect(rendered).toContain('data-plunk-link=');

    const value = stripRegionMarkers(rendered).replace('first.', 'today.');
    const next = applyEdits(original, [{id: paragraph!.id, value, previous: paragraph!.value}]);

    expect(next).not.toContain('data-plunk');
    expect(next).toBe('<p>Hi there &mdash; read <a href="https://example.com/guide">the guide</a> today.</p>');
  });
});
