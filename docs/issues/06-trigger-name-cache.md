# Issue: Trigger-name cache for high-volume events

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

Make the per-event cost flat, so behavioural events can be sent at product volume rather than a curated handful of milestones.

Today every single event runs the workflow trigger evaluation *and* a multi-join lookup for executions waiting on an event — the latter joining execution to contact and workflow, and step to its outgoing transitions and their target steps — regardless of whether the project has any wait-for-event step at all. At a few lifecycle events per user this is invisible; at real product volume it is the thing that falls over. This is a prerequisite for the rest of the PRD, not an optimisation.

Extend the existing Redis workflow cache to also hold, per project, the set of event names any enabled workflow triggers on, plus a flag for whether the project has any wait-for-event step. Event tracking consults this first and skips both lookups when nothing can possibly match.

Semantics must not change. An event no workflow reacts to is still recorded in full, and a workflow built later on an existing event name starts firing immediately — no event registry, no allowlist, no "enable this event" step. The existing cache-invalidation hook is extended to cover the new entries so that a workflow edit takes effect the way it does today.

## Acceptance criteria

- [ ] The workflow cache holds, per project, the set of triggering event names and a wait-for-event flag.
- [ ] An event whose name is in neither set is recorded, and skips both the trigger evaluation and the waiting-execution lookup.
- [ ] An event whose name matches still triggers its workflow exactly as before.
- [ ] Creating, editing, enabling, or disabling a workflow invalidates the cached entries, and a workflow built on an event name already in use begins firing on the next matching event with no further action.
- [ ] Disabling a workflow stops it firing, via the same invalidation.
- [ ] Cache unavailability fails safe — the system falls back to the uncached path rather than dropping triggers.
- [ ] A performance test asserts per-event cost stays flat as the number of distinct non-triggering event names grows.

## Blocked by

None - can start immediately
