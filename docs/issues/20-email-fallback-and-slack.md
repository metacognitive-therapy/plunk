# Issue: Email fallback and Slack notifications

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- **Email fallback.** When a visitor message is still unread by every relevant agent after the project's delay, the assignee (or every support agent, when unassigned) is emailed through platform mail. The email carries a preview and a link to the conversation. It is sent at most once per visitor message burst.
- **Slack.** A per-project incoming-webhook URL in Messenger settings, with a test button. New conversations, and visitor replies on unassigned conversations, are posted with a preview and an "Open in Plunk" link. Webhook failures are logged and never block message handling.
- Both run as worker jobs.

## Acceptance criteria

- [ ] An unread visitor message triggers one fallback email after the delay. A message read before the delay triggers none.
- [ ] A burst of messages produces one email, not one per message.
- [ ] With a webhook configured, a new conversation posts to Slack. Without one, nothing is attempted.
- [ ] A failing webhook does not affect delivery of the message itself.

## Blocked by

- `docs/issues/14-inbox-workflow.md`

## User stories

16, 17, 34
