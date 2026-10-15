# Issue: Conversation retention and erasure

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- The existing anonymize operation also hard-deletes the contact's conversations, messages and attachment objects.
- A per-project retention period in Messenger settings (months, default 24) and a scheduled BullMQ sweep that deletes closed conversations whose `closedAt` is older than the period. It works in bounded batches, like the email-body cleanup, and deletes their attachment objects.
- The same sweep purges messenger-created lead contacts that never gave an email and have been inactive for 90 days, along with their conversations.

## Acceptance criteria

- [ ] Anonymizing a contact leaves no conversation, message or attachment object behind.
- [ ] The sweep deletes only closed conversations past the period, never open or snoozed ones, and processes a large backlog in bounded batches.
- [ ] Inactive messenger leads with no email are purged after 90 days. Leads with an external id are never purged.

## Blocked by

- `docs/issues/17-private-attachments.md`

## User stories

35, 36
