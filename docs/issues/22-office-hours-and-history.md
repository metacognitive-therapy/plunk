# Issue: Office hours, reply time and visitor history

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Messenger settings gain a weekly office-hours schedule with a timezone and an expected reply-time label.
- The messenger home shows whether the team is online now or when it is back, plus the reply-time label. Outside hours the email prompt appears straight away instead of after the first message.
- The messenger home lists the visitor's previous conversations (scoped by session as before) with the last message and its unread state, and has a button to start a new conversation.

## Acceptance criteria

- [ ] Inside office hours the messenger says the team is online. Outside them it says when the team is back, computed in the project's timezone.
- [ ] Outside office hours the email prompt is shown before the visitor sends anything.
- [ ] A returning visitor sees their earlier conversations, can reopen one, and can start a new one.
- [ ] Unread agent replies are marked in the list.

## Blocked by

- `docs/issues/11-embeddable-messenger.md`

## User stories

3, 10, 31
