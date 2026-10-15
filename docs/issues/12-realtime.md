# Issue: Realtime delivery, typing and read receipts

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Replace refetching with pushes, in both the messenger and the Inbox.

- Server-Sent Events streams: one per messenger session (that visitor's conversations) and one per agent dashboard (the project's conversations).
- Redis pub/sub fan-out. Each API process holds a single subscriber connection and fans out in-process to its open streams.
- Events: message created, conversation updated, typing, read. Each event carries an id. A client that reconnects with `Last-Event-ID` refetches what it missed through the REST API, which stays the source of truth.
- Heartbeats keep proxies from closing idle streams.
- Typing is a debounced POST that publishes but never persists. Reads persist (`contactLastReadAt`, `ConversationRead`) and publish.
- The Inbox shows "Seen" under the agent's last comment once the visitor has read it. The messenger shows the typing indicator.

## Acceptance criteria

- [ ] A visitor message appears in an open Inbox without a refresh, and an agent reply appears in an open messenger without a refresh.
- [ ] A message published on one API instance reaches a stream held by another. The test uses two subscribers on one Redis.
- [ ] The number of Redis connections does not grow with the number of open streams.
- [ ] Typing indicators appear and clear in both directions.
- [ ] A dropped stream reconnects and the client catches up on anything it missed.
- [ ] A visitor's stream never carries events for conversations that session did not originate.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

6, 13, 27
