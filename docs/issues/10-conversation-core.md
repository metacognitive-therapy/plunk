# Issue: Conversation core

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

The thinnest end-to-end path: a visitor writes in a messenger, an agent reads it in the Inbox and answers, and the visitor sees the answer.

- Schema: `Conversation`, `ConversationMessage`, `ConversationRead`, a minimal `MessengerSettings` (enabled flag and allowed origins), and `Membership.supportAgent`.
- Messenger API under the public key: `boot` checks the request origin against the project's allowed origins, creates or resumes a lead contact through an `anonymous_id` `ContactIdentity`, and returns a short-lived signed session token. With that token the visitor can start a conversation, send a message, list their own conversations (scoped to `originVisitorId`), and read a conversation's messages. Reading marks `contactLastReadAt`.
- A first version of the messenger frame in a new `apps/widget` app, runnable as a standalone URL with the project public key in the query string. It boots, shows the conversation, and refetches on an interval. Realtime comes in issue 12 and the embeddable loader in issue 11.
- Agent API and an Inbox page in the dashboard: a cursor-paginated list ordered by `lastMessageAt`, a thread view, and a reply box. Reading a thread updates the agent's `ConversationRead`. `firstResponseAt` is set on the first agent comment.
- Every inbox route requires `supportAgent`, or the owner role. Project settings let an owner toggle `supportAgent` per member.

## Acceptance criteria

- [ ] A visitor on an allowed origin can boot, start a conversation, and send messages. A disallowed origin, or an empty allowlist, is refused.
- [ ] The visitor becomes a lead contact with an `anonymous_id` identity. Booting again with the same visitor id resumes the same contact.
- [ ] A session token from one project is rejected by another project, and an expired token is rejected.
- [ ] A session lists and reads only the conversations it originated.
- [ ] A support agent sees the conversation in the Inbox, replies, and the visitor sees the reply after the next refetch.
- [ ] A member without `supportAgent` gets 403 on every inbox route, and the Inbox is hidden from their navigation. Owners always have access.
- [ ] The inbox list query is index-backed (checked with `EXPLAIN`) and cursor-paginated.

## Blocked by

None. Consumes `ContactIdentity` from issue 08.

## User stories

2, 13, 29, 32 (allowlist only)
