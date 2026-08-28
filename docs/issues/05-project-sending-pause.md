# Issue: Project sending pause

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

An emergency brake that stops sending without losing anything.

The only existing brake is disabling a project, and that is checked in the authentication middleware — so it rejects *incoming* requests too. Using it to stop a bad send also stops the events arriving, discarding exactly the data needed to understand and recover from the problem. It is the wrong instrument.

Add a project-level sending pause, distinct from the disabled state. While it is set, no email is sent; ingestion, workflow execution, and sequence progression all continue normally. The check belongs in the email processor, where the disabled-project check already lives, and a paused send is marked **suppressed** — not cancelled and not failed — so an operator can see exactly what would have gone out and reason about the blast radius.

Critically, the pause must **not** be consulted by the authentication middleware. That is the whole distinction from the disabled state.

This is a per-project setting surfaced in project settings, not an environment variable: it must be flippable for one project without a redeploy, and a self-hosted deployment runs many projects. No environment variable is added by this slice. If implementation finds one genuinely unavoidable, the project's three-file rule applies and all three must be updated in the same change.

## Acceptance criteria

- [ ] A per-project sending pause exists, independent of the project disabled state, toggleable from project settings without a deploy.
- [ ] While paused, no email is sent by any path — campaign, sequence, workflow, or transactional API.
- [ ] A suppressed send is recorded with a status distinguishable from both cancelled and failed.
- [ ] While paused, event ingestion continues, workflows continue to execute, and sequences continue to progress.
- [ ] Unpausing allows subsequent sends without manual repair; the operator can see what was suppressed during the pause.
- [ ] The authentication middleware does not consult the pause; a paused project still accepts API requests.
- [ ] No environment variable is added or changed. If one proves unavoidable, all three of the development example, the self-host template, and the wiki reference are updated together.
- [ ] Wiki documents the pause and how it differs from disabling a project.

## Blocked by

None - can start immediately
