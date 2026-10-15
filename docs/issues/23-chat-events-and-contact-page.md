# Issue: Chat events and the contact page

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Reserved events emitted through the existing event pipeline: `conversation.started`, `conversation.replied` (a visitor message after the first), and `conversation.closed`. `chat.email_captured` is already emitted by issue 13. Event data carries the conversation id and channel.
- The reserved names are listed wherever Plunk lists its reserved events, so the workflow trigger picker offers them.
- The Inbox's right-hand panel shows the contact's data, contact tags, segments, recent events and other conversations.
- The contact detail page lists that contact's conversations, linking into the Inbox for support agents.

## Acceptance criteria

- [ ] Starting, replying to and closing a conversation each emit their event once, and a workflow triggered on `conversation.closed` runs.
- [ ] The contact panel shows the contact's profile without N+1 queries.
- [ ] The contact page lists conversations. Members who are not support agents see that conversations exist but cannot open their content.

## Blocked by

- `docs/issues/13-email-capture-and-consent.md`
- `docs/issues/14-inbox-workflow.md`

## User stories

26, 38, 39
