# Issue: Reply by email

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Close the loop for visitors who left the site.

- **Outbound.** A delayed BullMQ job emails an agent comment that is still unread by the visitor after the project's delay (default five minutes). It uses the transactional pipeline, branded by project, from the project's support address. The reply-to is `reply+<replyToken>@<reply subdomain>`, and `In-Reply-To`/`References` headers thread the conversation. `emailedAt` is set. `sendingPaused` holds the email, but the message is still delivered in the messenger. Attachments are linked through authenticated download links, not embedded.
- **Reply domain.** Messenger settings choose a receiving subdomain of one of the project's verified domains. Domain settings show the MX record to SES inbound beside the existing DNS rows.
- **Inbound.** The SES webhook recognises reply addresses before its existing shared-domain fan-out. A reply address resolves to exactly one conversation by token. Quoted history and signatures are stripped, and attachments are kept. If the sender matches the contact, the reply becomes a visitor message that reopens the conversation. Any other sender becomes a `NOTE` with `unverifiedSender` set. Unknown tokens are dropped. Replies do not count against `billingLimitInbound`.
- **Region.** Confirm that SES receiving is supported in the configured region. Document the receipt-rule setup in the wiki.

## Acceptance criteria

- [ ] An unread agent comment is emailed once, after the delay. A comment the visitor has already read is never emailed.
- [ ] A reply from the contact's address lands in the same conversation as a visitor message, without the quoted history.
- [ ] A reply from another address lands as a flagged note and is never shown to the visitor.
- [ ] A reply address never triggers the shared-domain fan-out, never creates or subscribes a contact, and never increments inbound usage.
- [ ] With `sendingPaused` the email is held. The messenger still shows the reply.

## Blocked by

- `docs/issues/13-email-capture-and-consent.md`

## User stories

7, 8, 28, 33
