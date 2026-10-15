# Issue: Intercom import

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Phase 3.

- A one-off, re-runnable import job, started from project settings with an Intercom access token that is used for the run and never stored.
- It pages through Intercom contacts and conversations through the REST API and resolves each contact through identify (external id first, then email). Existing subscription state is never changed.
- Conversations are written as closed and read-only, with `importedFrom` set to the Intercom id, the original timestamps, the author type (user or admin, mapped to contact or agent), and message bodies sanitized.
- Imported conversations are not emailed, pushed or evented.
- Progress and a summary (imported, skipped, failed) are visible while it runs. Running it again skips what is already imported.
- Before scheduling, size the workspace (contacts, conversations, messages) to set batch sizes.

## Acceptance criteria

- [ ] Running the import twice produces no duplicates.
- [ ] Imported conversations appear in the Inbox's Closed view and in the messenger history of a verified user.
- [ ] No events, emails or pushes are produced by the import.
- [ ] The token is not persisted anywhere.

## Blocked by

- `docs/issues/14-inbox-workflow.md`
- `docs/issues/25-identified-mode.md`

## User stories

47
