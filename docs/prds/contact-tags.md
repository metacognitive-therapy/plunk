# PRD: Contact Tags

Status: ready-for-agent
Date: 2026-08-24

## Problem Statement

As a Plunk user I have no lightweight way to label contacts with facts about who they are or what they did ("customer", "downloaded lead magnet", "attended webinar") and then act on those labels. Today my only options are custom data fields (not filterable as lists, no array support in the segment engine) and static segments (heavyweight, tangled into segment UX, membership events lag up to 5 minutes). Coming from ConvertKit, I expect tags to be the primary way I slice my audience: tag contacts from my app, from the dashboard, or from a CSV import, then send campaigns to "everyone tagged X but not Y" and kick off automations the instant a tag is applied.

## Solution

Introduce tags as a first-class concept, separate from segments, with ConvertKit parity:

- Tags are named labels scoped to a project. A contact either has a tag or doesn't.
- Tags can be applied/removed from the contact page, in bulk from the contacts list, via the public API (inline on track calls or through dedicated endpoints), via a CSV import column, and by workflow action steps.
- Campaigns can target tags directly with a one-click picker: send to contacts having ANY of the selected tags, minus an exclude list.
- The shared filter engine gains has-tag/not-has-tag operators, so dynamic segments and filtered campaigns can combine tags with any other condition.
- Applying or removing a tag emits a synchronous event that can trigger workflows immediately, bound by tag ID so renames never break automations.
- A dedicated Tags section in the dashboard lists tags with member counts and click-through to tagged contacts.

## User Stories

1. As a marketer, I want to create a tag with a name, so that I can start labeling contacts.
2. As a marketer, I want to rename a tag without breaking any campaign, segment, or workflow that uses it, so that I can fix naming mistakes safely.
3. As a marketer, I want to see all my tags with how many contacts each one has, so that I understand the shape of my audience at a glance.
4. As a marketer, I want to click a tag and see the contacts that have it, so that I can inspect who is in an audience.
5. As a marketer, I want to add and remove tags on a contact's detail page with an inline picker, so that I can curate individual contacts.
6. As a marketer, I want to see a contact's tags as chips on the contact page and in the contacts list, so that I can recognize a contact's labels instantly.
7. As a marketer, I want to filter the contacts list by one or more tags, so that I can find labeled groups quickly.
8. As a marketer, I want to select many contacts (including "all matching the current filter") and bulk add or remove tags, so that I can retag large groups without scripting.
9. As a marketer, I want to map a CSV column to tags during import, so that contacts arrive already labeled.
10. As a developer, I want to pass a list of tag names inline on a track call, so that tagging rides along with event tracking in a single request.
11. As a developer, I want tags referenced by name to be auto-created if missing, so that my integration doesn't need a tag-creation handshake first.
12. As a developer, I want dedicated API endpoints to create, list, rename, and delete tags and to add/remove tags on a contact, so that external systems can manage labels explicitly.
13. As a developer, I want "VIP", "vip", and " vip " to resolve to the same tag, so that API typos don't triple my tag list.
14. As a marketer, I want to create a campaign targeting contacts who have ANY of the selected tags, so that I can broadcast to a labeled audience in one click.
15. As a marketer, I want to add an exclude list of tags to a campaign audience, so that I can send to "customers except launch-optouts".
16. As a marketer, I want to preview the recipient count of a tag-targeted campaign before sending, so that I know exactly who will receive it.
17. As a marketer, I want dynamic segments to include "has tag" / "doesn't have tag" conditions combined with any other filter, so that I can build audiences like "tagged customer AND signed up in the last 30 days".
18. As a marketer, I want filtered (inline-condition) campaigns to use the same has-tag operators, so that ad-hoc sends can use tags without creating a segment.
19. As a marketer, I want a workflow to start the moment a specific tag is added to a contact, so that tag application drives email sequences in real time.
20. As a marketer, I want a workflow to start when a specific tag is removed, so that I can react to state changes (e.g. churn).
21. As a marketer, I want workflows to bind to the tag itself (not its name), so that renaming a tag never silently disables an automation.
22. As a marketer, I want workflow steps that add or remove a tag on the contact flowing through the workflow, so that automations can maintain labels (e.g. tag "nurtured" after a sequence completes).
23. As a marketer, I want re-adding a previously removed tag to fire the tag-added trigger again, with per-workflow re-entry rules deciding whether the contact re-enters, so that repeatable behaviors work predictably.
24. As a marketer, I want adding a tag a contact already has to be a silent no-op, so that duplicate API calls don't double-fire automations.
25. As a marketer, I want to delete an unused tag and have its memberships cleaned up, so that my tag list stays tidy.
26. As a marketer, I want deleting a tag that is referenced by an active campaign, an enabled workflow, or a segment condition to be blocked with a clear list of what references it, so that nothing silently breaks.
27. As a marketer, I want every tag add/remove recorded as an event on the contact's activity timeline, so that I have an audit trail of labeling.
28. As a self-hosting operator, I want tag membership counts to be cached and reconciled periodically rather than counted live, so that the tags page stays fast with millions of contacts.
29. As a developer, I want bulk tag operations to run as background jobs with progress polling, so that tagging 500k contacts doesn't time out an HTTP request.
30. As a marketer, I want tags and static segments to coexist, so that my existing curated lists keep working unchanged.
31. As an MCP user, I want tag management exposed through the Plunk MCP server, so that agents can label contacts conversationally.
32. As a self-hosting operator, I want the wiki docs and OpenAPI spec updated with tags, so that my team can discover the feature.

## Implementation Decisions

### Data model

- New `Tag` entity: id, name, project relation, timestamps. Name is unique per project **case-insensitively** (trimmed); the display casing of first creation is preserved.
- New `ContactTag` join entity: composite primary key (contact, tag), `createdAt`. Rows are **hard-deleted** on removal — no soft-exit history (deliberate divergence from `SegmentMembership`; the Event table is the audit trail).
- `Tag` carries a cached `memberCount`, incremented/decremented on apply/remove and reconciled by the existing periodic segment-count sweep job (per the repo's scale rules: cache computed values, never live-count in request paths).
- Indexes to support: lookup by tag (list members), lookup by contact (render chips), and the campaign recipient join.

### Identity & lifecycle

- Tag resolution by name is trim + case-insensitive everywhere (API, import, workflow actions). Auto-create on first reference from `/v1/track`, import, and workflow action config that references a name; dedicated endpoints create explicitly.
- Rename is always allowed and always safe: campaigns, workflows, and segment conditions bind by tag **ID**, never by name or slug.
- Applying an already-present tag is a no-op: no event, no trigger, no count change.
- Deleting a tag referenced by any campaign (tagIds/excludeTagIds), enabled workflow (trigger or add/remove-tag step), or segment/filter condition returns a conflict error enumerating the references (mirrors segment-deletion blocking and the event-usage endpoint pattern). Unreferenced deletion removes `ContactTag` rows via a background job when large.

### Events & automation

- Applying/removing a tag synchronously emits reserved events `tag.added` / `tag.removed` through the existing event service, with payload `{tagId, tagName}` — same synchronous path as `/v1/track`, NOT the 5-minute segment sweep. `tag.*` joins the reserved-event namespace (like `email.*`, `segment.*`).
- Workflow trigger matching is extended: in addition to event-name matching, a workflow can bind to `triggerConfig.tagId` + direction (added/removed). Dispatch compares the event payload's tagId, making renames inert.
- Re-adding a removed tag fires `tag.added` again; whether the workflow re-runs for that contact is governed by the existing per-workflow `allowReentry` flag.
- Two new workflow step types: `ADD_TAG` and `REMOVE_TAG`, configured by tag ID (picker in the editor). These emit the same events (and can therefore chain automations).

### Campaign targeting

- New campaign audience type `TAG` alongside ALL / FILTERED / SEGMENT, with `tagIds` (match ANY — union) and `excludeTagIds` (subtracted). Recipient resolution joins through `ContactTag` inside the existing recipient-where builder, preserving the subscribed-unless-transactional base rule and cursor pagination.
- ALL-of-several-tags targeting is intentionally not a picker mode; it remains expressible via FILTERED mode.

### Filter engine

- The shared segment/filter engine gains two operators: `hasTag` and `notHasTag`, valued by tag ID. Available in dynamic segment conditions, FILTERED campaign conditions, and workflow CONDITION steps (shared operator vocabulary). Zod schema, TypeScript types, and the stale operator-docs list are updated together.
- Tags become a field category in the filter-builder UI alongside Custom data / Events / Email activity / Segments.

### API surface

- `POST /v1/track` (public key) accepts optional `tags: string[]` — applied by name with auto-create, after contact upsert, before event-driven workflow dispatch. Accepted trade-off: public-key holders can create tags (they can already create contacts).
- New tags controller under the dual-mode dashboard/secret-key auth middleware: list (with counts), create, rename, delete, list a tag's contacts (paginated), and add/remove a tag for a contact. Contact responses include their tags.
- Bulk add/remove tags endpoints on the contacts controller following the existing bulk-action pattern (background job + job-status polling, supporting select-all-matching with exclusions).
- CSV import: an optional tags column (delimiter-separated names within the cell), resolved/auto-created per row by the import processor.
- `/v1/send` does NOT accept tags.
- MCP server gains matching tag tools.

### Dashboard UI

- New Tags index page: list with member counts, create/rename/delete, click-through to a filtered contacts view.
- Contact detail: tag chips with inline add/remove picker.
- Contacts list: tags rendered as chips, a tag facet filter (first facet beyond search/status), and bulk tag/untag actions in the existing bulk-select toolbar.
- Campaign composer: TAG audience mode with include/exclude tag pickers and recipient-count preview.
- Workflow editor: tag trigger picker (tag + added/removed) and ADD_TAG/REMOVE_TAG step configuration.

### Coexistence

- Static segments remain untouched; no migration tooling, no deprecation. Tags and static segments coexist.

## Testing Decisions

Good tests here assert **external behavior at existing seams** — API responses, database state transitions, emitted events, recipient sets — never internal call sequences or private helpers. All five seams already exist in the codebase; no new test infrastructure is required.

1. **Service seam (real test DB + factories)** — tag CRUD and identity rules (case-insensitive dedupe, trim, rename), apply/remove semantics (no-op re-add, count maintenance), delete-blocking with reference enumeration, and the `hasTag`/`notHasTag` operators. Prior art: the segment service tests and the dedicated segment operator test suite.
2. **Public API integration seam** — `/v1/track` with inline tags (auto-create, idempotent re-apply, reserved-name rejection unaffected), tag CRUD endpoints, contact tag add/remove, auth modes (public key vs secret key vs JWT). Prior art: the Actions API integration tests.
3. **Event→workflow dispatch seam** — tag.added/removed starting workflows bound by tagId, rename not breaking bindings, allowReentry honored on re-add, ADD_TAG/REMOVE_TAG steps mutating membership and chaining events. Prior art: the event service and workflow execution integration tests.
4. **Campaign recipient-resolution seam** — TAG audience: ANY-union across tagIds, exclude subtraction, subscribed-filter interaction, recipient count vs cursor consistency. Prior art: the campaign service tests.
5. **Background-job seam** — bulk tag/untag processor: batching, select-all-matching with exclusions, progress reporting, count reconciliation. Prior art: the import processor and bulk action job tests.

No UI page-level tests (no precedent in the web app beyond lib-level unit tests).

## Out of Scope

- Tag colors, descriptions, or grouping/folders.
- Tag membership history ("was tagged X within 30 days" filters) — hard-delete model chosen deliberately.
- ALL-match semantics in the campaign tag picker (expressible via FILTERED mode).
- `tags` on `/v1/send`.
- Migration or conversion tooling between static segments and tags; static-segment deprecation.
- Tag-based rate limiting, quotas, or per-tag analytics dashboards.
- Zapier/integration directory work beyond the raw API.

## Further Notes

- The synchronous tag events deliberately bypass the 5-minute segment sweep — this is the key latency difference between tags and trackMembership segments, and the main reason tags exist as a separate concept.
- The reserved-event namespace must reject user-supplied `tag.*` names on `/v1/track` (same guard as `segment.*`).
- Env vars, wiki docs (concepts + guides + API reference), the OpenAPI spec, and MCP schemas all have listed update obligations in the repo instructions; treat them as part of the feature, not follow-ups.
- Bulk operations and count reconciliation must follow the repo's scale rules: cursor pagination, batching, background jobs, no live aggregate counts in request paths.
