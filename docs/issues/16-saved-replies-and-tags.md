# Issue: Saved replies and conversation tags

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- **Saved replies.** Project-scoped title and body, managed in Messenger settings and inserted into the reply box from a picker (`#` shortcut). Plunk's existing template variables (for example `{{firstName}}`) are resolved against the conversation's contact on insert, with the same fallback syntax the template engine already supports.
- **Conversation tags.** Project-scoped labels, separate from contact tags. They can be added and removed on a conversation and used as an Inbox filter.

## Acceptance criteria

- [ ] Agents can create, edit and delete saved replies. Inserting one resolves variables against the contact.
- [ ] Agents can create tags, apply them to and remove them from conversations, and filter the Inbox by tag. The filter is index-backed.
- [ ] Deleting a tag removes it from every conversation without touching contact tags.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

24, 25
