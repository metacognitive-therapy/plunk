# Issue: Email capture and consent

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

After the visitor's first message the messenger asks for an email, with an optional unticked "send me news" checkbox.

- **No contact has that email.** The email is set on the lead with `subscribed=false`, or `true` if the box was ticked.
- **The email belongs to an existing contact.** The lead's conversations and identities are re-pointed onto that contact and the empty lead is deleted. The existing contact's subscription state is not changed by chat, except to subscribe if the box was ticked.
- The visitor's session is re-issued for the surviving contact but stays unverified: it still sees only conversations whose `originVisitorId` is its own visitor id.
- The reserved event `chat.email_captured` is emitted once per capture.
- Re-pointing a lead that has an `externalId` or tags is refused. Only bare messenger leads are re-pointed, so the operation never becomes a general merge.

## Acceptance criteria

- [ ] An email for a new address creates no new contact: it sets the email on the lead, unsubscribed unless the box was ticked.
- [ ] An email matching an existing contact moves the conversations and identities and deletes the lead. The existing contact keeps its tags, history and subscription state.
- [ ] After the re-point, the visitor session cannot list or read any of the existing contact's other conversations.
- [ ] `chat.email_captured` is emitted with the conversation id.
- [ ] Conversation emails still reach a chat contact who did not opt in. This holds because transactional sends ignore `subscribed`.
- [ ] Capturing an email on an anonymized contact is refused.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

4, 5, 12
