# Issue: Inbox workflow (states, snooze, assignment)

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Conversation states: Open, Snoozed and Closed. Snooze runs either until a date or until the visitor replies (`snoozedUntil` is null).
- A visitor message reopens a closed or snoozed conversation.
- A scheduled BullMQ sweep reopens snoozed conversations whose `snoozedUntil` has passed.
- Assignment to any support agent of the project, or unassigned.
- Inbox views: Unassigned, Mine, All (open and snoozed), and Closed, each with a count.
- Status and assignment changes are recorded as `SYSTEM` messages in the thread. `closedAt` is set on close.

## Acceptance criteria

- [ ] An agent can close, reopen, snooze until a date, snooze until reply, assign, and unassign. Each change appears in the thread as a system line.
- [ ] A visitor message on a closed or snoozed conversation reopens it.
- [ ] A snoozed conversation reappears in Open after its date, through the sweep.
- [ ] Each view lists the right conversations and its count is correct. Every view query is index-backed.
- [ ] Only support agents of the project can be assignees.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

19, 20, 21, 22
