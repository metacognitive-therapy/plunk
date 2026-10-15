# Issue: Internal notes and mentions

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Agents can post a `NOTE` in a thread. Notes are visually distinct and never shown to the visitor.
- Notes are never sent over the visitor's stream, never emailed, and never returned by the messenger API.
- `@` in a note opens a picker of the project's support agents. Mentioned agents are recorded on the message, and each one gets a mention notification. The notification uses the in-app channel now, and the channels from issues 19 and 20 once those land.

## Acceptance criteria

- [ ] A note appears in the agent thread and is absent from every messenger API response and stream event.
- [ ] A note does not count as a first response and does not reopen or close anything.
- [ ] Mentioning an agent notifies them. Mentioning someone who is not a support agent is not possible.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

23
