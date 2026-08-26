# PRD: Editing imported HTML templates

Status: ready-for-agent

## Problem Statement

Someone brings an HTML email they already have — a Stripo or BEE export, a designer's
handoff, an LLM's output, a template they have been sending for a year — and pastes it
into Plunk. From that moment the rich editor refuses to touch it. The mode toggle flips
to HTML and stays there, and every subsequent change to a headline, a button label or an
image has to be made by hand in a CodeMirror gutter.

This is not a bug. `detectCustomHtmlPatterns` deliberately locks the visual editor out of
anything containing `<div>`, `<table>`, `data-*`, `id=`, or a class outside a small
allowlist, because the loaded TipTap extension set has no Table or Div nodes and would
silently flatten the markup on round-trip. The lock is protecting the template. The
consequence is that the rich editor can only ever edit content it authored itself, which
is the opposite of what "use an HTML template" means.

Two smaller problems compound it:

- **Preview is gated behind picking a contact.** The entire preview pane — device
  switcher included — renders only when a contact is selected, and it sits below the
  editor rather than beside it. A project with no contacts cannot preview at all.
- **Templates are not reusable.** Only `WorkflowStep` carries a `templateId`. Campaigns
  and sequence steps have no link to a template, so every body is typed from scratch even
  when a perfectly good one exists two pages away.

## Solution

Stop letting the rich text editor own the document.

Instead of asking TipTap to parse, model and re-emit a table-based email — which it
cannot do without destroying it — render the template as it actually is and make
individual elements editable in place. Click a headline in the preview and type. A
floating toolbar offers bold, italic, link and variable insertion. Click an image to
swap it; click a button to repoint it. Only the single clicked leaf element is editable
at any moment, so the editor is never in a position to reflow the layout around it.

Saving does not re-serialize the document. The original HTML is parsed with source
location information, and only the byte ranges the user actually edited are replaced.
Every untouched byte survives verbatim — conditional comments, attribute casing, VML
fallbacks, whitespace. Editing a headline provably cannot change anything else in the
file.

Editing happens against the raw template with variables shown as atomic chips; previewing
against a contact is a separate, read-only mode. This is deliberate: the preview
substitutes `{{email}}` for a real address, and allowing edits on that rendered view
would splice one contact's data permanently into the template.

Structural editing — adding a section, reordering blocks, turning one column into two —
is explicitly **not** part of this. It cannot be inferred from opaque markup, and is
deferred to a native block model.

### Tiers

|                        | Imported HTML | Plunk-native blocks (future) |
| ---------------------- | ------------- | ---------------------------- |
| Edit text              | yes           | yes                          |
| Swap image             | yes           | yes                          |
| Edit link URL          | yes           | yes                          |
| Restyle                | later         | yes                          |
| Add / remove section   | no            | yes                          |
| Reorder blocks         | no            | yes                          |

## User Stories

1. As a marketer, I want to paste an HTML email I already have into Plunk, so that I do not have to rebuild it.
2. As a marketer, I want to upload a `.html` file, so that I do not have to open it in a text editor to copy its contents.
3. As a marketer, I want to click a headline in the rendered email and retype it, so that I can change copy without reading HTML.
4. As a marketer, I want bold, italic and links available while editing text in place, so that inline emphasis does not force me into the code view.
5. As a marketer, I want to click an image and upload a replacement, so that swapping a hero image is not an exercise in finding the right `src` attribute.
6. As a marketer, I want to click a button and change where it points, so that reusing last month's template does not send people to last month's link.
7. As a marketer, I want to see which parts of the email are editable before I click, so that I am not guessing.
8. As a marketer, I want to insert a personalisation variable while editing text, so that I can add `{{firstName}}` without hand-typing braces.
9. As a marketer, I want variables shown as single indivisible chips while I edit, so that I cannot half-delete one and silently break a send.
10. As a marketer, I want to preview the email filled in with a real contact's data, so that I can check the personalisation reads correctly.
11. As a marketer, I want to see the preview without first choosing a contact, so that a new project with no contacts can still design an email.
12. As a marketer, I want the preview beside what I am editing rather than below it, so that I can see the effect without scrolling.
13. As a marketer, I want to check the email at mobile, tablet and desktop widths, so that I can catch a layout that breaks on a phone.
14. As a developer, I want the HTML I wrote to come back byte-identical apart from what was edited, so that my Outlook fallbacks and conditional comments survive a marketer's typo fix.
15. As a developer, I want a code view available at all times, so that I can make the changes the visual editor deliberately will not.
16. As a marketer, I want to start a campaign from a saved template, so that I am not copy-pasting HTML between pages.
17. As a marketer, I want to start a sequence step from a saved template, so that every email in a drip can share a shell.
18. As a marketer, I want editing a template afterwards to leave my existing campaigns and sequences alone, so that fixing a typo cannot rewrite mail that is already scheduled or in flight.
19. As a marketer, I want to know that a template is a starting point rather than a live link, so that I am not surprised by either behaviour.
20. As a marketer, I want a clear signal when a template contains something the visual editor will not edit, so that I know to switch to code rather than assume it is broken.
21. As a security-conscious admin, I want third-party HTML rendered without executing scripts, so that pasting a template cannot run code in the dashboard.
22. As a marketer, I want undoing a change to work the way it does everywhere else, so that a mistaken edit is one keystroke from being fixed.

## Implementation Decisions

### Editing model

Editing is per-element, never per-document. The rich text editor is reduced from document
owner to an inline toolbar bound to one element at a time. This is the decision the whole
design rests on: it is what makes table-based markup safe, because no code path exists in
which the editor can reflow the structure around the text it is editing.

**An editable unit** is the innermost element that contains text and has no element
children beyond inline formatting (`b`, `strong`, `i`, `em`, `u`, `a`, `span`, `br`,
`font`, `small`). Separately, every `img` is swappable and every `a` has an editable
`href`. Anything else — a `<td>` wrapping a nested table, a layout `<div>` — is not
editable and not clickable.

### Round-trip fidelity

The template is parsed with **parse5** using `sourceCodeLocationInfo: true`, which yields
exact character offsets for every node and its inner content. Saving splices the new inner
HTML into the original string at those offsets, applying edits back-to-front so earlier
offsets stay valid. The document is never re-serialized from a DOM.

parse5 is already present in the dependency tree and needs promoting to a direct
dependency of `apps/web`. It runs client-side (click-to-edit needs region inference in the
browser) behind a dynamic import, so it lands in the editor's chunk rather than the shared
bundle. Sanitization uses `dompurify`, which `apps/web` already depends on directly.

The pure surface, which is where all correctness lives:

```ts
// Both are DOM-free and deterministic. This is the test seam.
inferEditableRegions(html: string): EditableRegion[]

interface EditableRegion {
  kind: 'text' | 'image' | 'link';
  // Byte offsets into the ORIGINAL html string.
  start: number;      // inner content start (text), or attribute value start
  end: number;        // inner content end
  // A stable identifier so the iframe DOM can address a region without offsets.
  id: string;
  tagName: string;
  preview: string;    // short label for hover/aria
}

// Applies edits back-to-front. Nested edits collapse into their enclosing text
// edit (see below); genuinely crossing ranges are not constructible and throw.
applyEdits(html: string, edits: {id: string; value: string}[]): string
```

**Nesting is the normal case, not an error.** `a` is in the inline-formatting allowlist, so
`<p>Read <a href="x">this</a> now</p>` yields a text region for the `<p>` whose range fully
contains the link region's `href` range; a styled button is simultaneously a text region
and a link region. Editing the paragraph copy and the link URL in one save must produce one
splice, not a rejection. The rule: when a text region is edited, its new value is the
serialized inner content and therefore *already carries* any nested link or image change, so
nested edits are dropped from the batch rather than applied. The throw is reserved for
ranges that partially overlap, which region inference cannot produce and which would
indicate a bug.

**Region ids are injected at render time**, as a `data-plunk-region` attribute, rather than
derived as a positional path through the parse5 tree. The browser re-parses whatever is
handed to the iframe and need not agree with parse5's tree shape, and sanitization removes
nodes — either would desync a path. The order is therefore: infer offsets against the
original → inject id attributes → sanitize → render. What is stored is always the untouched
original.

### Variables

While editing, the template is rendered **unsubstituted**. Each `{{ ... }}` expression and
each `{% ... %}` tag inside an editable region is rendered as an atomic, non-editable chip
(`contenteditable="false"`), so it can be moved or deleted whole but never partially
typed. On splice, chips serialize back to their exact original expression text.

Liquid that spans element boundaries — `{% if %}` opening in one element and `{% endif %}`
closing in another — makes the enclosing regions non-editable, because an edit there
cannot be reasoned about locally.

Preview-as-contact remains substituted and becomes explicitly read-only.

### Modes

The `Visual | HTML` toggle becomes **`Edit | Code | Preview`**.

- `Edit` — click-to-edit against the raw template. Works on any HTML.
- `Code` — the existing CodeMirror view, unchanged. Always available.
- `Preview` — substituted, read-only, with the existing device widths, and **not gated on
  selecting a contact**. With no contact chosen it renders the raw template.

The forced mode flips `detectCustomHtmlPatterns` drives, and the "you will lose your custom
HTML" confirmation dialog, are removed. TipTap's whole-document mode is retained behind a
flag for one release, then deleted.

The predicate itself is **not** simply deleted. It has a second, unrelated caller:
`wrapEmailWithStyles` uses it to decide whether a body is already a complete document and
should be left alone instead of being wrapped in the style shell. Deleting it outright would
either stop wrapping simple content or double-wrap full documents. Only the editor-gating
use is removed; the wrapper keeps a narrow, separately named `isCompleteHtmlDocument`
predicate, and the existing `emailStyles.test.ts` cases are re-pointed at whichever of the
two they were actually asserting.

### Reuse

`Campaign` and `SequenceStep` gain **no** foreign key to `Template`. Choosing a template
copies its `body`, and optionally `subject`, into the editor at insert time and the
relationship ends there. Editing a template later cannot alter a scheduled campaign or a
drip a contact is mid-way through, and `Email` rows continue to be the record of what was
actually sent.

The picker is a dialog listing the project's templates, filtered to the matching
`TemplateType`, mounted wherever `EmailEditor` is.

### Security

The preview and edit iframes are `sandbox`ed. `<script>` elements, `on*` attributes and
`javascript:` URLs are stripped from what is rendered — never from what is stored, since
stored bytes must survive verbatim.

### Undo

Each element edit commits as one entry on an explicit edit journal held by the editor, so
undo crosses element boundaries in the order the user made the changes rather than being
trapped inside whichever element currently has focus.

### Not in this PRD

Structural editing, a block model, the lossy "convert imported HTML to blocks" path, and
restyling (colour, spacing, fonts). Restyling is inferable but messy — a button's colour
is commonly set in four places at once — and is deliberately sequenced after this ships.

## Testing Decisions

A good test here asserts on external behaviour: given this HTML in, this HTML out. It does
not assert on how regions are discovered, what the intermediate tree looks like, or in
what order edits are applied.

The `plunk` vitest project runs `environment: 'node'` with no jsdom, and the only existing
web test (`LogicMention.test.ts`) is pure logic. Rather than introduce jsdom — whose
iframe and `contenteditable` support would not faithfully exercise this feature anyway —
every correctness-bearing decision is pushed into DOM-free functions tested at that
existing seam. The React layer is kept deliberately thin: iframe wiring and click routing,
with no logic worth asserting on.

**Tested** (`apps/web/src/lib/htmlTemplate/__tests__/`, node):

- `applyEdits` — the byte-preservation guarantee. Fixtures include a Stripo-style export,
  a template with MSO conditional comments and VML, and one with unquoted and
  upper-cased attributes. The core assertion is that everything outside the edited range
  is byte-identical, not merely equivalent.
- `applyEdits` — multiple edits in one save, including edits whose offsets precede one
  another; and editing a paragraph together with a link nested inside it, which must
  produce a single splice rather than an error.
- `inferEditableRegions` — a headline inside three nested tables is found; a `<td>`
  wrapping a nested table is not offered; images and links are found wherever they sit.
- Variable chips — round-trip an expression unchanged; refuse a region containing a
  `{% if %}` that closes in a different element.
- Sanitization — `<script>`, `on*` and `javascript:` are absent from render output and
  present in stored output.

Prior art: `apps/api/src/services/__tests__/SequenceService.test.ts` for structure, and
`LogicMention.test.ts` for the existing pure-logic-in-web pattern.

**Not tested**: the iframe component, click routing, and the floating toolbar. This is a
known gap and an accepted one; both bugs found during sequences QA were of exactly this
wiring class, so the feature is expected to need a browser QA pass before it is trusted.

## Out of Scope

- Structural editing of imported HTML, and any block model.
- Converting imported HTML into editable blocks.
- Restyling: colours, spacing, fonts.
- A drag-and-drop email builder.
- Any foreign key linking campaigns or sequence steps to templates.
- Changing how email is rendered or sent. This is an authoring-time feature only; the
  stored `body` remains a plain HTML string and the send path is untouched.

## Further Notes

The lock this replaces was correct for what it was defending. Removing
`detectCustomHtmlPatterns` is only safe *because* the editing model changed underneath it;
loosening the heuristic on its own would have started corrupting templates.

The byte-splice decision is the one to hold the line on under schedule pressure.
Re-serializing a DOM is markedly simpler and is correct for well-formed markup, which
means it will pass every test anyone thinks to write and then break a client nobody can
test, after a campaign has gone out.
