# PRD: Sequences

Status: ready-for-agent
Date: 2026-08-25

## Problem Statement

As a Plunk user I want to send an evolving, ongoing series of emails — a newsletter that grows week over week — where every contact experiences the full series from the beginning, and where a contact who has already caught up automatically receives new installments as soon as I publish them. Today, Workflows can express a step sequence, but a `WorkflowExecution` is a one-pass pointer through a step graph: once it reaches the end it is marked `COMPLETED` with `currentStepId: null` and is permanently terminal — adding new steps later never reaches contacts who already finished. `allowReentry` doesn't help either; it only lets a contact start an entirely new execution from step one, replaying content they've already seen. Campaigns are one-off sends with no notion of an ordered, growing series. Coming from ConvertKit, I expect a dedicated "Sequences" concept: an ordered list of emails I can keep adding to indefinitely, with a clean editor per email, automatic delayed delivery per contact, and enrollment that just works — new subscribers start at email one, existing subscribers who are caught up get the new email on the next delivery pass, and subscribers still mid-sequence keep experiencing normal pacing.

## Solution

Introduce Sequences as a first-class concept, separate from Workflows and Campaigns:

- A **Sequence** is a named, ordered list of **Sequence Steps** (subject + body, editable like a campaign), each with a delay relative to the contact's own previous step send — not a fixed calendar date. A Sequence has its own campaign type (marketing/transactional/headless), set once for the whole sequence.
- Contacts are **enrolled** in a sequence manually (dashboard picker, mirroring the Tags bulk-action selector) or via the public API, or automatically when a specific tag is applied (reusing the existing `tag.added` event). Every new enrollee always starts at step one — full sequence, ConvertKit-style, never fast-forwarded.
- A background sweep, running every 5 minutes, finds contacts whose next unsent step is due (delay since their own last sequence send has elapsed) and sends it via the existing Campaign send pipeline (`EmailService.sendCampaignEmail`), so deliverability safeguards (bounce/complaint handling, unsubscribe footer, open/click tracking) are inherited rather than reimplemented.
- Progress is tracked as the **set of steps already sent** to each contact (a `SequenceStepSend` record per contact per step), not a single position pointer. This means steps can always be edited or reordered — even after some contacts have received them — without risking a double-send or a skip: each sweep simply looks at "lowest-order step this contact hasn't received yet, if its delay has elapsed."
- New steps are created as **drafts** and require an explicit **Publish** action before the sweep will ever send them — so a week's issue can be drafted over several days without going out prematurely. Because catch-up delay is computed relative to the contact's own previous send (not the step's publish date), a contact who is already caught up receives a freshly published step on the very next sweep with no artificial holdback.
- A Sequence itself has a top-level status — **Draft** (not accepting enrollments, nothing sends), **Active** (enrolling and sending normally), **Paused** (existing enrollments keep their progress but nothing sends until resumed) — mirroring the existing `Workflow.enabled`-style on/off pattern already in the codebase.
- Unenrollment happens two ways: (a) implicitly, a contact with `subscribed=false` is simply skipped by the sweep (same rule Campaigns already follow), so they resume automatically if they re-subscribe without losing progress; (b) explicitly, manual removal from a specific sequence. Removing the enrolling tag does **not** auto-unenroll — tags and sequence membership are deliberately decoupled once enrollment has happened.
- A dedicated Sequences section in the dashboard (nav item alongside Dashboard/Contacts/Segments/Tags/Sequences/Activity) lists sequences with enrollment counts, and a per-sequence page lists steps in order with drag-reorder and inline editing.

## User Stories

1. As a marketer, I want to create a Sequence with a name and campaign type, so that I can start building an ongoing email series.
2. As a marketer, I want to add steps to a sequence with a subject, body, and a delay relative to the previous step, so that I can control pacing.
3. As a marketer, I want new steps to start as drafts, so that I can prepare next week's email over several days without it sending prematurely.
4. As a marketer, I want to explicitly publish a step when it's ready, so that I control exactly when it becomes eligible to send.
5. As a marketer, I want to reorder steps at any time, even after some have been sent to some contacts, so that I can fix mistakes or restructure the series without fear of breaking delivery.
6. As a marketer, I want to edit the content of a step at any time, even after it's been sent to some contacts, so that I can correct typos or update information for contacts who haven't received it yet.
7. As a marketer, I want reordering or editing a sequence to never cause a contact to receive the same step twice or skip a step, so that I can trust the sequence is safe to keep evolving.
8. As a marketer, I want to manually enroll a contact or a bulk-selected group of contacts into a sequence from the dashboard, so that I can curate who's in the series.
9. As a marketer, I want every new enrollee to start at step one regardless of how many steps already exist, so that everyone gets the full series from the beginning.
10. As a developer, I want a dedicated API endpoint to enroll a contact in a sequence, so that external systems can drive enrollment.
11. As a marketer, I want a sequence to auto-enroll a contact when I apply a specific tag to them, so that tagging drives sequence membership without a manual step.
12. As a marketer, I want a contact who is already caught up on a sequence to receive a newly published step on the very next delivery pass, so that publishing a new issue reaches everyone who's ready for it right away.
13. As a marketer, I want a contact who is mid-sequence to keep experiencing normal per-step delay pacing even while new steps are published, so that catching up doesn't disrupt someone already in progress.
14. As a marketer, I want a contact whose global subscription is off to simply be skipped by sequence sends (not unenrolled), so that they resume automatically if they resubscribe without losing their place.
15. As a marketer, I want to manually remove a contact from a sequence, so that I can unenroll someone independent of their global subscription status.
16. As a marketer, I want removing the tag that originally enrolled a contact to NOT automatically unenroll them, so that tag cleanup doesn't have surprising side effects on active sequences.
17. As a marketer, I want to set a sequence's status to Draft, Active, or Paused, so that I can prepare a sequence before it goes live or pause an active one without losing anyone's progress.
18. As a marketer, I want a paused sequence to stop sending while preserving every enrolled contact's current progress, so that I can resume later exactly where things left off.
19. As a marketer, I want sequence emails to use the same unsubscribe footer, open/click tracking, and bounce handling as campaigns, so that sequence sends are just as compliant and measurable as any other Plunk email.
20. As a marketer, I want to see aggregate open/click stats for a sequence, so that I can gauge overall engagement (per-step breakdown is out of scope for v1).
21. As a developer, I want dedicated REST API endpoints and MCP tools to create/list/update sequences and steps and to enroll/unenroll contacts, so that I can manage sequences programmatically the same way I manage tags today.
22. As a marketer, I want a dedicated Sequences page in the dashboard navigation, so that I can find and manage my sequences alongside Contacts, Segments, Tags, and Workflows.
23. As a marketer, I want a per-sequence page listing steps in order with drag-to-reorder and inline editing, so that managing a sequence feels as clean as ConvertKit's editor.
24. As a self-hosting operator, I want the sequence sweep to run on a fixed, bounded interval (5 minutes) rather than scheduling a job per contact per step, so that the feature stays performant at scale (1M+ contacts).

## Implementation Decisions

- **New Prisma models**:
  - `Sequence`: `id`, `projectId`, `name`, `status` (`DRAFT` | `ACTIVE` | `PAUSED`), `type` (reuse `TemplateType`: `MARKETING` | `TRANSACTIONAL` | `HEADLESS`, matching `Campaign.type`), timestamps.
  - `SequenceStep`: `id`, `sequenceId`, `order` (integer, mutable — reordering updates this), `subject`, `body`, `delayMinutes` (or similar unit) since the contact's own previous sequence send, `published` (boolean, drafts default `false`), timestamps.
  - `SequenceSubscription`: `id`, `sequenceId`, `contactId`, `enrolledAt`, unique on `(sequenceId, contactId)` — this is enrollment/membership, separate from send history.
  - `SequenceStepSend`: `id`, `sequenceId`, `sequenceStepId`, `contactId`, `sentAt`, `emailId` (FK to the `Email` row created by `EmailService.sendCampaignEmail`) — the "sent-set." Unique on `(sequenceStepId, contactId)` to make double-send structurally impossible.
- **Send pipeline reuse**: sequence sends go through `EmailService.sendCampaignEmail` (`apps/api/src/services/EmailService.ts:118`), the same lowest-level single-send primitive `CampaignService.processBatch` uses (`CampaignService.ts:594`). `SendEmailParams` already has `workflowExecutionId`/`workflowStepExecutionId` fields for attribution — add a matching `sequenceStepSendId` (or `sequenceId`/`sequenceStepId`) field following that existing pattern, rather than building new send/tracking logic.
- **Sweep job**: new `apps/api/src/jobs/sequence-sweep-processor.ts` (naming convention matches existing `campaign-stats-sweep-processor.ts`, `card-verification-sweep-processor.ts`), with its `Queue` declared in `QueueService.ts` and its worker registered in `apps/api/src/jobs/worker.ts`'s `startWorkers()`. Repeatable registration follows the existing pattern in `apps/api/src/app.ts` (`queue.add(name, data, { repeat: { pattern: '*/5 * * * *' }, jobId: 'sequence-sweep-repeatable' })`), matching the fixed-`jobId` convention used by domain verification and campaign-stats sweeps to prevent duplicate registration on restart.
- **Sweep query logic**: for each `ACTIVE` sequence, for each enrolled contact (via `SequenceSubscription`) who is globally `subscribed`, find the lowest-`order` `published` `SequenceStep` with no matching `SequenceStepSend` for that contact, where `now - (contact's most recent SequenceStepSend.sentAt for this sequence, or enrolledAt if none)` ≥ that step's `delayMinutes`. Batch this query and process in bounded chunks (mirroring the batching approach in `CampaignService.processBatch`) to stay within the scale requirements for 1M+ contacts — never load the full contact set into memory at once.
- **Editing/reordering safety**: because progress is the sent-set, not a pointer, no guard logic is needed on step edit/reorder beyond normal validation (unlike `WorkflowService.ts:648-666`'s active-execution guard) — the sweep query above is correct under arbitrary reordering by construction.
- **Status semantics**: `DRAFT` sequence — no enrollments accepted, sweep skips it entirely. `ACTIVE` — enrollments accepted, sweep processes it. `PAUSED` — sweep skips it (no sends), but existing `SequenceSubscription`/`SequenceStepSend` rows are untouched, so resuming to `ACTIVE` picks up exactly where it left off. Modeled as a `status` enum on `Sequence` rather than reusing `Workflow.enabled`'s boolean, since three states are needed.
- **Unenrollment**: implicit skip via `Contact.subscribed=false` (checked in the sweep query, no new field). Explicit unenroll deletes the `SequenceSubscription` row (progress in `SequenceStepSend` can be left in place or cascade-deleted — recommend cascade-delete on unenroll, since re-enrollment always restarts at step one per the "always step one" decision, so stale `SequenceStepSend` rows serve no purpose). No coupling to tag removal.
- **API surface** (`apps/api/src/controllers/Sequences.ts`, mirroring `Tags.ts`'s shape and `@Middleware([requireAuth, requireEmailVerified])` + `@CatchAsync` pattern): `GET /sequences`, `GET /sequences/:id`, `POST /sequences`, `PATCH /sequences/:id`, `DELETE /sequences/:id`; nested step routes `POST /sequences/:id/steps`, `PATCH /sequences/:id/steps/:stepId`, `DELETE /sequences/:id/steps/:stepId`, `POST /sequences/:id/steps/:stepId/publish`; enrollment routes `POST /sequences/:id/contacts` (bulk enroll, mirroring `POST /tags/bulk-apply`'s async-job pattern for large selections), `DELETE /sequences/:id/contacts/:contactId`.
- **MCP tools**: `apps/mcp/src/tools/sequences.ts`, mirroring `apps/mcp/src/tools/tags.ts`'s tool set and addressing pattern (by ID, with name-lookup convenience where tags did the same).
- **Auto-enroll on tag applied**: subscribe to the existing `tag.added` event (same event tag-triggered workflows already consume) and, for any `Sequence` configured with an enrolling `tagId`, create a `SequenceSubscription` if one doesn't already exist. Bound to the tag's ID, not its name, consistent with how tag-triggered workflows already avoid breaking on rename.
- **Dashboard**: new nav item "Sequences" alongside Dashboard/Contacts/Segments/Tags/Workflows/Activity. List page (name, status, enrollment count — reusing patterns from the Workflows/Campaigns list pages). Detail page with ordered step list (drag-reorder), inline step editor (reuse the existing campaign content editor component where possible), publish action per step, and a contact enrollment picker reusing the Tags bulk-action contact selector pattern.
- **v1 enrollment scope**: manual dashboard picker + API, and tag-triggered auto-enroll only. Explicitly deferred: public opt-in/signup forms, and `/v1/track`/CSV-import-based enrollment.
- **v1 analytics scope**: sequence-level aggregate open/click totals only (same shape as existing Campaign stats). Per-step breakdown deferred to v2 — the `SequenceStepSend` join table already gives the send records needed, so no schema change is required later.
- **Implementation delegation**: the actual implementation work for this feature is to be delegated to the `claude-fable-5` model (via `Agent`/`Workflow` tool `model` overrides at the implementation phase) — a process/tooling choice orthogonal to this PRD's design decisions.

## Testing Decisions

- Follow the same layered seam pattern established for Tags:
  - **Integration tests** (`apps/api/src/__tests__/integration/sequences.test.ts`, mirroring `tags.test.ts`): exercise the full `Sequences` controller surface — create/list/update/delete sequence, add/publish/reorder/edit steps, enroll/unenroll contacts — asserting on API responses and resulting DB state, not internal implementation.
  - **Service unit tests** (`apps/api/src/services/__tests__/SequenceService.test.ts`, mirroring `TagService.test.ts`): cover the sweep's "next due step" selection logic directly — including reordering-safety cases (step reordered after some contacts already received earlier steps; step edited after being sent to some contacts; new step published while some contacts are caught up vs. mid-sequence) — since this is the most failure-prone logic in the feature.
  - **Sweep job tests** (`apps/api/src/jobs/__tests__/sequence-sweep-processor.test.ts`, mirroring `bulk-tag-processor.test.ts`): cover batching behavior and confirm no double-send / no skip under concurrent sweep runs.
  - **Event-emission test** (`apps/api/src/services/__tests__/EventService.sequences.test.ts` or extend the existing tag-event test, mirroring `EventService.tags.test.ts`): confirm `tag.added` correctly triggers auto-enrollment.
- Only test external behavior (API responses, DB state, email sends recorded) — not internal call counts or private methods, consistent with the project's existing test style.

## Out of Scope

- Public opt-in/signup forms for sequence enrollment.
- `/v1/track`-based or CSV-import-based enrollment.
- Auto-unenroll when the enrolling tag is removed.
- Per-step open/click analytics UI (deferred to v2; data model already supports it).
- Fast-forwarding new enrollees to the latest step (all enrollees always start at step one).
- Per-step campaign type overrides (type is set once for the whole sequence).
- Any change to the existing Workflow engine's terminal-completion or `allowReentry` semantics — Sequences is a new, separate concept, not a Workflow extension.

## Further Notes

This PRD directly resolves the product gap identified during research into evolving/growing newsletters: Workflow executions are permanently terminal on completion (`WorkflowExecutionService.ts:1304-1315` sets `status: COMPLETED, currentStepId: null`), and `allowReentry` only replays the entire sequence from scratch rather than resuming — neither supports a ConvertKit-style series that keeps growing and reaches already-caught-up subscribers. Sequences is deliberately a new, separate concept rather than an extension of Workflows, because the underlying data shape is fundamentally different: Workflows are a general directed step graph addressed by a single pointer, while Sequences need an ordered list with per-contact multi-step progress tracking (the sent-set) to safely support the "always editable and reorderable" requirement. The design was reached via a structured design-interview (`/grill-me`) covering enrollment, unenrollment, editing safety, campaign-type scope, draft/publish, sequence status, send-pipeline reuse, sweep cadence, analytics scope, API/MCP surface, testing seams, and the core data model — all decisions above reflect that interview's conclusions.