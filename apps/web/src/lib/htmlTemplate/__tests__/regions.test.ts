import {describe, expect, it} from 'vitest';

import {applyEdits, hasBalancedLiquidBlocks, inferEditableRegions, injectRegionMarkers} from '../regions';
import type {EditableRegion} from '../types';

/**
 * A Stripo-style export: nested layout tables, MSO conditional comments with a VML
 * fallback, an inline style attribute, an unquoted attribute and an upper-cased
 * one. Every one of these is something a DOM round-trip would normalize away, so
 * this fixture is the point of the whole module.
 */
const STRIPO_EXPORT = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<style type="text/css">
@media only screen and (max-width:600px) { .col { width:100% !important; } }
</style>
</head>
<body style="margin:0;padding:0;">
<table role="presentation" WIDTH=600 cellpadding=0 cellspacing="0" border="0">
  <tr>
    <td class="col" style="padding:24px 16px;">
      <h1 style="font-size:28px;margin:0;">Welcome aboard</h1>
      <p style="line-height:1.6;">Hi there &mdash; read <a href="https://example.com/guide">the guide</a> before you start.</p>
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" arcsize="10%" fillcolor="#2563eb">
        <w:anchorlock/><center>Get started</center>
      </v:roundrect>
      <![endif]-->
      <a href="https://example.com/start" style="background:#2563eb;color:#fff;padding:12px 20px;">Get started</a>
      <img src=https://cdn.example.com/logo.png width="120" alt="Logo" />
    </td>
  </tr>
</table>
</body>
</html>`;

/** Asserts that `edited` differs from `original` only inside the given ranges. */
function assertUntouchedOutside(original: string, edited: string, regions: EditableRegion[]) {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  // Everything before the first region, and after the last, must survive verbatim.
  expect(edited.slice(0, first.start)).toBe(original.slice(0, first.start));

  const lastEnd = last.end;
  const tailLength = original.length - lastEnd;
  expect(edited.slice(edited.length - tailLength)).toBe(original.slice(lastEnd));
}

describe('inferEditableRegions', () => {
  it('reports region values that are exact slices of the source', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);

    expect(regions.length).toBeGreaterThan(0);
    for (const region of regions) {
      expect(STRIPO_EXPORT.slice(region.start, region.end)).toBe(region.value);
    }
  });

  it('finds the headline and paragraph but not the layout table or cell', () => {
    const text = inferEditableRegions(STRIPO_EXPORT).filter(r => r.kind === 'text');
    const tags = text.map(r => r.tagName);

    expect(tags).toContain('h1');
    expect(tags).toContain('p');
    // A `td` wrapping block elements has layout inside it; editing it as rich text
    // is exactly what destroys table-based email markup.
    expect(tags).not.toContain('td');
    expect(tags).not.toContain('table');
    expect(tags).not.toContain('body');
  });

  it('treats a link inside a paragraph as editable text plus a separate URL region', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);
    const paragraph = regions.find(r => r.kind === 'text' && r.tagName === 'p');
    const guideLink = regions.find(r => r.kind === 'link' && r.value === 'https://example.com/guide');

    expect(paragraph).toBeDefined();
    expect(guideLink).toBeDefined();
    // The link's URL is separately addressable, and it sits inside the paragraph.
    expect(guideLink!.start).toBeGreaterThan(paragraph!.start);
    expect(guideLink!.end).toBeLessThan(paragraph!.end);
    // The paragraph's editable content still includes the anchor markup itself.
    expect(paragraph!.value).toContain('<a href="https://example.com/guide">the guide</a>');
  });

  it('does not emit a nested text region for a link inside a paragraph', () => {
    const paragraph = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'text' && r.tagName === 'p')!;
    const nested = inferEditableRegions(STRIPO_EXPORT).filter(
      r => r.kind === 'text' && r.start > paragraph.start && r.end < paragraph.end,
    );

    expect(nested).toEqual([]);
  });

  it('reads an unquoted attribute value without swallowing the following attribute', () => {
    const image = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'image');

    expect(image?.value).toBe('https://cdn.example.com/logo.png');
  });

  it('leaves MSO conditional comments and VML outside every region', () => {
    const mso = STRIPO_EXPORT.indexOf('<!--[if mso]>');
    const msoEnd = STRIPO_EXPORT.indexOf('<![endif]-->');
    const covering = inferEditableRegions(STRIPO_EXPORT).filter(r => r.start < msoEnd && mso < r.end);

    expect(covering).toEqual([]);
  });

  it('finds the standalone button link, whose text is editable and URL separately addressable', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);
    const button = regions.find(r => r.kind === 'link' && r.value === 'https://example.com/start');
    const buttonText = regions.find(r => r.kind === 'text' && r.value === 'Get started');

    expect(button).toBeDefined();
    expect(buttonText).toBeDefined();
  });

  it('handles a document fragment with no html or body wrapper', () => {
    const regions = inferEditableRegions('<p>Just a fragment</p>');

    expect(regions.map(r => r.value)).toContain('Just a fragment');
  });
});

describe('hasBalancedLiquidBlocks', () => {
  it('accepts a self-contained conditional', () => {
    expect(hasBalancedLiquidBlocks('Hi {% if name %}{{ name }}{% endif %}!')).toBe(true);
  });

  it('accepts plain output tags', () => {
    expect(hasBalancedLiquidBlocks('Hello {{ firstName }}')).toBe(true);
  });

  it('rejects a conditional that opens without closing', () => {
    expect(hasBalancedLiquidBlocks('{% if vip %}Welcome back')).toBe(false);
  });

  it('rejects a stray close', () => {
    expect(hasBalancedLiquidBlocks('Welcome back{% endif %}')).toBe(false);
  });

  it('rejects mismatched block types', () => {
    expect(hasBalancedLiquidBlocks('{% if a %}x{% endfor %}')).toBe(false);
  });
});

describe('inferEditableRegions with Liquid', () => {
  it('does not offer a region whose conditional closes in a different element', () => {
    const html = '<td><p>{% if vip %}</p><p>VIP</p><p>{% endif %}</p></td>';
    const values = inferEditableRegions(html)
      .filter(r => r.kind === 'text')
      .map(r => r.value);

    // The middle paragraph is self-contained and stays editable; the two halves of
    // the straddling conditional do not.
    expect(values).toContain('VIP');
    expect(values).not.toContain('{% if vip %}');
    expect(values).not.toContain('{% endif %}');
  });

  it('keeps a variable inside an otherwise ordinary paragraph editable', () => {
    const region = inferEditableRegions('<p>Hi {{ firstName }}, welcome.</p>').find(r => r.kind === 'text');

    expect(region?.value).toBe('Hi {{ firstName }}, welcome.');
  });
});

describe('applyEdits', () => {
  it('is a no-op with no edits', () => {
    expect(applyEdits(STRIPO_EXPORT, [])).toBe(STRIPO_EXPORT);
  });

  it('changes only the edited headline and leaves every other byte alone', () => {
    const headline = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'text' && r.tagName === 'h1')!;
    const result = applyEdits(STRIPO_EXPORT, [{id: headline.id, value: 'Welcome back', previous: headline.value}]);

    expect(result).toBe(
      STRIPO_EXPORT.slice(0, headline.start) + 'Welcome back' + STRIPO_EXPORT.slice(headline.end),
    );
    // The things a DOM round-trip would have normalized.
    expect(result).toContain('<!--[if mso]>');
    expect(result).toContain('<v:roundrect');
    expect(result).toContain('WIDTH=600 cellpadding=0');
    expect(result).toContain('src=https://cdn.example.com/logo.png');
    expect(result).toContain('@media only screen and (max-width:600px)');
    expect(result).toContain('&mdash;');
  });

  it('rewrites an image URL without touching its sibling attributes', () => {
    const image = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'image')!;
    const result = applyEdits(STRIPO_EXPORT, [{id: image.id, value: 'https://cdn.example.com/new.png', previous: image.value}]);

    expect(result).toContain('<img src=https://cdn.example.com/new.png width="120" alt="Logo" />');
  });

  it('applies several disjoint edits in one pass', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);
    const headline = regions.find(r => r.kind === 'text' && r.tagName === 'h1')!;
    const image = regions.find(r => r.kind === 'image')!;
    const button = regions.find(r => r.kind === 'link' && r.value === 'https://example.com/start')!;

    const result = applyEdits(STRIPO_EXPORT, [
      // Deliberately out of document order: ordering is the function's job.
      {id: image.id, value: 'https://cdn.example.com/new.png', previous: image.value},
      {id: headline.id, value: 'Welcome back', previous: headline.value},
      {id: button.id, value: 'https://example.com/onboarding', previous: button.value},
    ]);

    expect(result).toContain('>Welcome back</h1>');
    expect(result).toContain('src=https://cdn.example.com/new.png');
    expect(result).toContain('href="https://example.com/onboarding"');
    assertUntouchedOutside(STRIPO_EXPORT, result, [headline, image, button]);
  });

  it('collapses a nested link edit into the enclosing paragraph edit', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);
    const paragraph = regions.find(r => r.kind === 'text' && r.tagName === 'p')!;
    const guideLink = regions.find(r => r.kind === 'link' && r.value === 'https://example.com/guide')!;

    // This is the ordinary case, not an error: the paragraph's new inner HTML
    // already carries the new href, so the nested edit must be dropped rather
    // than applied a second time against shifted offsets.
    const result = applyEdits(STRIPO_EXPORT, [
      {id: paragraph.id, value: 'Hi there — read <a href="https://example.com/handbook">the handbook</a> first.', previous: paragraph.value},
      {id: guideLink.id, value: 'https://example.com/handbook', previous: guideLink.value},
    ]);

    expect(result).toContain('<a href="https://example.com/handbook">the handbook</a> first.');
    expect(result).not.toContain('example.com/guide');
    // Exactly one splice happened: the surrounding markup is intact.
    expect(result).toContain('<!--[if mso]>');
    assertUntouchedOutside(STRIPO_EXPORT, result, [paragraph]);
  });

  it('applies a nested link edit on its own when the paragraph is untouched', () => {
    const guideLink = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'link' && r.value === 'https://example.com/guide')!;
    const result = applyEdits(STRIPO_EXPORT, [{id: guideLink.id, value: 'https://example.com/handbook', previous: guideLink.value}]);

    expect(result).toContain('<a href="https://example.com/handbook">the guide</a>');
  });

  it('rejects an edit whose region no longer exists', () => {
    expect(() => applyEdits(STRIPO_EXPORT, [{id: 'r9999', value: 'x', previous: ''}])).toThrow(/Unknown region/);
  });

  it('refuses an edit whose region no longer holds the bytes it was inferred against', () => {
    const headline = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'text' && r.tagName === 'h1')!;

    expect(() =>
      applyEdits(STRIPO_EXPORT, [{id: headline.id, value: 'Welcome back', previous: 'something else entirely'}]),
    ).toThrow(/no longer holds the content/);
  });

  it('refuses a stale id that now names a region of a different kind', () => {
    // Ids are positional. Here `r1` is a link's href; after the source changes it
    // is a paragraph's text. Without the `previous` check this splices a URL into
    // a paragraph — or, reversed, a paragraph's markup into an href — and reports
    // success.
    const before = '<p>Alpha</p><a href="https://example.com">Beta</a>';
    const link = inferEditableRegions(before).find(r => r.kind === 'link')!;
    expect(link.id).toBe('r1');

    const after = '<p>Alpha</p><p>Beta</p>';
    expect(inferEditableRegions(after).find(r => r.id === 'r1')?.kind).toBe('text');

    expect(() => applyEdits(after, [{id: link.id, value: 'https://example.com/moved', previous: link.value}])).toThrow(
      /no longer holds the content/,
    );
  });

  it('refuses two edits to the same region', () => {
    const headline = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'text' && r.tagName === 'h1')!;

    expect(() =>
      applyEdits(STRIPO_EXPORT, [
        {id: headline.id, value: 'One', previous: headline.value},
        {id: headline.id, value: 'Two', previous: headline.value},
      ]),
    ).toThrow(/edited twice/);
  });

  it('survives a round trip through repeated edits', () => {
    const first = inferEditableRegions(STRIPO_EXPORT).find(r => r.kind === 'text' && r.tagName === 'h1')!;
    const once = applyEdits(STRIPO_EXPORT, [{id: first.id, value: 'Welcome back', previous: first.value}]);

    // Ids are re-derived against the edited source, which is the only safe basis
    // for a second pass.
    const second = inferEditableRegions(once).find(r => r.kind === 'text' && r.tagName === 'h1')!;
    const twice = applyEdits(once, [{id: second.id, value: 'Welcome aboard', previous: second.value}]);

    expect(twice).toBe(STRIPO_EXPORT);
  });
});

describe('inline images', () => {
  // A social-links row: icon and label share a cell. Excluding `img` from the
  // inline set froze the whole row — no label was editable anywhere in it.
  // Wrapped in a table: parse5 discards a cell that has no table around it.
  const SOCIAL_ROW =
    '<table><tr><td class="social">Follow us: <a href="https://example.com/ig"><img src="https://cdn.example.com/ig.png" width="20"> Instagram</a></td></tr></table>';

  it('makes a cell holding an icon and its label editable', () => {
    const regions = inferEditableRegions(SOCIAL_ROW);
    const cell = regions.find(r => r.kind === 'text' && r.tagName === 'td');

    expect(cell?.value).toContain('Follow us:');
    expect(cell?.value).toContain('Instagram');
  });

  it('still offers the icon as its own image region', () => {
    // Clicking the icon must swap the image, not type over it, even though the
    // icon now sits inside an editable text region.
    const regions = inferEditableRegions(SOCIAL_ROW);

    expect(regions.find(r => r.kind === 'image')?.value).toBe('https://cdn.example.com/ig.png');
  });

  it('does not treat a lone image as editable text', () => {
    // No non-whitespace text, so there is nothing to edit as prose.
    const regions = inferEditableRegions('<table><tr><td class="logo"><img src="https://cdn.example.com/logo.png"></td></tr></table>');

    expect(regions.some(r => r.kind === 'text')).toBe(false);
  });

  it('rewrites a label without disturbing the icon markup', () => {
    const regions = inferEditableRegions(SOCIAL_ROW);
    const cell = regions.find(r => r.kind === 'text' && r.tagName === 'td')!;
    const next = applyEdits(SOCIAL_ROW, [
      {id: cell.id, value: cell.value.replace('Instagram', 'Our Instagram'), previous: cell.value},
    ]);

    expect(next).toContain('<img src="https://cdn.example.com/ig.png" width="20"> Our Instagram');
  });
});

describe('raw-text elements', () => {
  it('does not offer a stylesheet as editable text', () => {
    // Caught in browser QA: `<style>` holds a single text child, so it passed the
    // inline-only test and the template's CSS became click-to-edit rich text.
    const regions = inferEditableRegions(STRIPO_EXPORT);

    expect(regions.some(r => r.tagName === 'style')).toBe(false);
  });

  it.each(['script', 'title', 'textarea', 'noscript'])('does not offer <%s> as editable text', tag => {
    const regions = inferEditableRegions(`<${tag}>some content</${tag}>`);

    expect(regions.some(r => r.tagName === tag)).toBe(false);
  });
});

describe('injectRegionMarkers', () => {
  it('marks each region on its own element without disturbing other bytes', () => {
    const regions = inferEditableRegions(STRIPO_EXPORT);
    const marked = injectRegionMarkers(STRIPO_EXPORT, regions);

    expect(marked).toContain('<h1 data-plunk-text=');
    expect(marked).toContain('<img data-plunk-image=');
    expect(marked).toContain('<!--[if mso]>');
    // Nothing was removed: markers are pure insertions.
    expect(marked.length).toBeGreaterThan(STRIPO_EXPORT.length);
    for (const region of regions) {
      expect(marked).toContain(`="${region.id}"`);
    }
  });

  it('gives an anchor both its text and link markers', () => {
    const marked = injectRegionMarkers('<a href="https://example.com">Go</a>', inferEditableRegions('<a href="https://example.com">Go</a>'));

    expect(marked).toContain('data-plunk-link=');
    expect(marked).toContain('data-plunk-text=');
  });

  it('leaves markup with no editable content unchanged', () => {
    const html = '<table><tr><td></td></tr></table>';

    expect(injectRegionMarkers(html, inferEditableRegions(html))).toBe(html);
  });
});
