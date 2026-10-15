# PRD: Live Chat (Messenger and Inbox)

Status: ready-for-agent
Date: 2026-10-15

## Problem Statement

Our websites have no way for a visitor to talk to us. Someone reading about metacognitive therapy on metacognitivetherapy.com, or about a course on the MKT-Oslo site, who has a question has to find an email address, write a message, and wait. Most of them simply leave. For noworries.app we pay for Intercom to get exactly this: a chat bubble in the corner, a conversation that continues by email when the person leaves, and an inbox where the team answers.

Intercom works, but it is a second system holding our contacts. Everything Plunk knows about a person (their tags, segments, sequence position, the events they triggered) is invisible to whoever answers a chat, and nothing said in a chat can drive a Plunk workflow. Intercom also stores conversations from people who may describe their mental health, on a platform whose retention and access we do not control. And it is priced per seat and per feature for a team that uses a fraction of it.

As a member of the support team I need one place, inside Plunk, where messages from visitors arrive in real time, where I am notified when someone writes even if the dashboard is closed, where I can see who the person is, and where I can answer, hand off, snooze, and close conversations. As a site owner I need a snippet I can paste into Webflow that gives visitors an Intercom-quality messenger in our own brand.

## Solution

Build a messenger and a support inbox into Plunk, modelled on Intercom, delivered in three phases.

**Phase 1: websites.** A per-project messenger embedded with one script tag. A tiny loader script draws the launcher and exposes a JavaScript API; the messenger itself runs in an iframe served from our domain, so the host site's CSS cannot break it. Visitors can write immediately without identifying themselves; they become a lead contact, and the messenger asks for an email after the first message so we can reply if they leave. Agent replies appear live while the visitor is on the page and are emailed to them if they are not; the visitor can answer that email and the reply lands back in the same conversation.

Each project gets an Inbox page, visible to members flagged as support agents. Conversations are open, snoozed, or closed; they can be assigned to a teammate; agents can leave internal notes with @mentions, insert saved replies, and tag conversations. The contact's Plunk profile sits beside the thread. Agents are notified in the dashboard, by browser push (including on a phone, via the installable dashboard), by email when a message sits unread, and in Slack.

Chat is a first-class Plunk citizen: conversations emit events that existing workflows and segments can react to, and a contact's conversations appear on their contact page.

**Phase 2: noworries.app.** A JavaScript-only React Native SDK that gives the app a native-feeling messenger on the same API, push notifications for replies, verified identity for logged-in users, and identify/track wrappers that take over the attribute and event logging the app currently sends to Intercom.

**Phase 3: migration.** A one-off import of noworries' Intercom contacts and conversations, after which Intercom is switched off.

## User Stories

### Visitor

1. As a visitor, I want a chat launcher on the website, so that I can ask a question without leaving the page.
2. As a visitor, I want to start writing immediately without filling in a form, so that asking a quick question takes no effort.
3. As a visitor, I want the messenger to tell me when the team is available and how quickly they usually reply, so that I know what to expect.
4. As a visitor, I want to be asked for my email after I write, so that I can leave the site and still get the answer.
5. As a visitor, I want to choose separately whether I also want news from the organisation, so that asking a support question does not sign me up for marketing.
6. As a visitor, I want to see the agent's reply appear live, and see when they are typing, so that the conversation feels like a chat rather than a form.
7. As a visitor, I want replies I missed to arrive by email, so that I do not have to return to the website to read them.
8. As a visitor, I want to answer that email from my inbox and have it reach the same conversation, so that I can continue wherever I am.
9. As a visitor, I want to attach a screenshot or a file, so that I can show the problem instead of describing it.
10. As a visitor, I want to see my earlier conversations when I come back to the site, so that I do not have to repeat myself.
11. As a visitor, I want the messenger to look like the organisation's own product, so that I trust it.
12. As a visitor, I want my conversation history not to be readable by someone who merely types my email address, so that my support history stays private.

### Agent

13. As an agent, I want new conversations to appear in my inbox the instant they are created, so that I can answer while the visitor is still on the page.
14. As an agent, I want a browser notification when someone writes, even if the dashboard tab is closed, so that I do not have to watch the inbox.
15. As an agent, I want to install the dashboard on my phone and get push notifications there, so that I can answer when I am away from my desk.
16. As an agent, I want an email when a message has gone unread for a while, so that nothing is missed when no one is online.
17. As an agent, I want new conversations posted to our Slack channel, so that the team sees them where it already works.
18. As an agent, I want to see an unread count in the sidebar and the tab title, so that I know at a glance whether anyone is waiting.
19. As an agent, I want inbox views for Unassigned, Mine, All, and Closed, so that I can work through what is mine and pick up what is no one's.
20. As an agent, I want to assign a conversation to a teammate, so that the right person answers it.
21. As an agent, I want to close a conversation and have it reopen if the visitor writes again, so that the inbox reflects what still needs attention.
22. As an agent, I want to snooze a conversation until a date or until the visitor replies, so that it leaves my inbox until it needs me.
23. As an agent, I want to write internal notes that the visitor never sees, and @mention a teammate in them, so that I can ask for help inside the conversation.
24. As an agent, I want saved replies with personalisation variables, so that I can answer common questions quickly and consistently.
25. As an agent, I want to tag conversations, so that we can find and later report on billing questions, bugs, and sales enquiries.
26. As an agent, I want to see the contact's Plunk profile (data, tags, segments, recent events) beside the conversation, so that I know who I am talking to.
27. As an agent, I want to see when the visitor has read my reply, so that I know whether they have seen it.
28. As an agent, I want an email reply from an unexpected address to be shown to me but not treated as the visitor's message, so that a leaked reply address cannot be used to impersonate them.

### Admin and operator

29. As a project owner, I want to choose which members are support agents, so that members who only run campaigns do not read support conversations that may contain health information.
30. As a project owner, I want to set the messenger's colour, greeting, launcher position, and team avatars, so that it matches the brand.
31. As a project owner, I want to set office hours and the expected reply time, so that visitors are told the truth about availability.
32. As a project owner, I want to restrict which websites may embed the messenger, so that no one can put our messenger on their own site.
33. As a project owner, I want replies to be emailed from our own domain, so that MKT-Oslo visitors never see a Metacognitive Therapy address or vice versa.
34. As a project owner, I want to configure a Slack webhook for the project, so that chat notifications go to the right channel.
35. As a project owner, I want closed conversations deleted after a retention period I choose, so that we do not keep sensitive conversations forever.
36. As an operator, I want anonymizing a contact to erase their conversations and attachments, so that an erasure request is fully honoured.
37. As an operator, I want the public messenger endpoints protected against bots and floods, so that the inbox is not filled with spam.

### Marketer and developer

38. As a marketer, I want conversation started, replied, closed, and email-captured events, so that I can trigger workflows such as a follow-up after a conversation closes.
39. As a marketer, I want a contact's conversations listed on their contact page, so that support history is part of their profile.
40. As a developer, I want a JavaScript API to open, close, and update the messenger, so that I can open it from a "Contact us" button.
41. As a developer, I want to identify a logged-in user with a token signed by my backend, so that their history follows them across devices without trusting an email typed into a form.

### noworries (Phase 2 and 3)

42. As a noworries user, I want to chat with support inside the app, so that I do not have to leave it.
43. As a noworries user, I want a push notification when support replies, so that I see the answer without opening the app.
44. As a noworries user, I want my full conversation history on any device I sign in on, so that changing phones does not lose it.
45. As a noworries developer, I want an SDK whose surface mirrors the Intercom React Native SDK, so that replacing it is mostly mechanical.
46. As a noworries developer, I want the SDK to record the user attributes and events we currently log to Intercom, so that Plunk becomes the single place those live.
47. As an agent, I want past noworries conversations from Intercom available in Plunk, so that I have context for returning users after the switch.

## Implementation Decisions

### Scope and phasing

- Phase 1 (websites) ships first and is self-contained. Phase 2 (noworries SDK, identified mode, push, analytics) and Phase 3 (Intercom import) are planned now so that Phase 1's API does not need breaking changes later.
- Phase 2's analytics work depends on identify resolution and binding, track by external id, and the trigger-name cache (issues 02, 03, 06 of the contact-identity PRD). All three have landed on `next`, so the dependency is satisfied; it is recorded here because those slices are what make product-volume event tracking from the SDK safe.

### Projects, inboxes, and access

- **Per-project inbox.** Conversations belong to a project, exactly like contacts and campaigns. Each brand's website embeds its own project's messenger. There is no cross-project inbox in this PRD.
- **`Membership.supportAgent` (new boolean, default false).** Only flagged members, and owners always, can open the Inbox, receive chat notifications, and appear as assignees. Every inbox route is guarded on it, not just hidden in the navigation. Notifications cover every project the agent belongs to, so switching projects never hides an incoming chat.

### Data model

New models, all carrying `projectId` and indexed for project-scoped queries:

- **`Conversation`**: `contactId`, `status` (`OPEN` / `SNOOZED` / `CLOSED`), `snoozedUntil` (nullable; null with `SNOOZED` means "until the visitor replies"), `assigneeId` (nullable user), `channel` (`WIDGET` / `EMAIL` / `MOBILE` / `IMPORT`), `originVisitorId` (the anonymous id that started it; scopes what an unverified session may see), `replyToken` (unique, unguessable; the `reply+<token>` local part), `lastMessageAt`, `lastContactMessageAt`, `contactLastReadAt`, `firstResponseAt`, `closedAt`, `importedFrom` (nullable). Indexes: `(projectId, status, lastMessageAt)`, `(projectId, assigneeId, status, lastMessageAt)`, `(contactId)`, `(status, snoozedUntil)` for the wake-up sweep, `(status, closedAt)` for retention.
- **`ConversationMessage`**: `conversationId`, `authorType` (`CONTACT` / `AGENT` / `SYSTEM`), `authorUserId` (nullable), `kind` (`COMMENT` / `NOTE`), `body` (stored as sanitized lightweight markdown), `source` (`WIDGET` / `EMAIL` / `SDK` / `IMPORT`), `unverifiedSender` (nullable email, set on the flagged-note path), `emailedAt` (set when delivered by email), `createdAt`. Index `(conversationId, createdAt)`.
- **`ConversationAttachment`**: `messageId`, private object key, filename, content type, size.
- **`ConversationRead`**: `(userId, conversationId)` → `lastReadAt`, driving per-agent unread counts and the "seen" indicator in the other direction.
- **`ConversationTag`** and its join to conversations: project-scoped labels, separate from contact tags.
- **`SavedReply`**: project-scoped title and body.
- **`MessengerSettings`**: one row per project: enabled flag, allowed origins, accent colour, launcher position, greeting, office-hours schedule and timezone, reply-time label, reply domain, Slack webhook URL, retention period (months, default 24), email-fallback delay, and the messenger signing secret for identified mode (Phase 2).
- **`WebPushSubscription`**: per user and device: endpoint and keys.
- Agent-side activity (assignment and status changes) is stored as `SYSTEM` messages in the thread, so the timeline is self-describing and a later reporting slice can backfill from it.

### Visitor identity and sessions

- **Anonymous first.** On first contact the messenger creates a lead contact (no email) and records an `anonymous_id` `ContactIdentity` for the visitor id. This consumes the identity table built in the contact-identity PRD.
- **Session token.** `boot` exchanges the project public key plus the visitor id for a short-lived signed session token naming the project, contact, visitor id, and whether the session is verified. Every subsequent messenger call authenticates with this token, never with cookies inside the iframe.
- **Persistence.** The visitor id is persisted by the loader as a first-party cookie on the host site and handed to the iframe over `postMessage`. Third-party iframe storage is partitioned per top-level site and capped by Safari's tracking prevention, so it cannot hold identity reliably. The consequence, accepted: an anonymous visitor is not recognised across two different websites, which matches per-project inboxes.
- **Email capture.** After the first visitor message the messenger asks for an email, with an optional unticked "send me news" checkbox. The contact is created or updated through the existing identify rules with `subscribed=false` unless the box is ticked; an existing contact's subscription state is never changed by chat. Transactional sends are exempt from `subscribed` (`apps/api/src/database/contact-filters.ts`), so conversation emails still reach them.
- **Email that already belongs to a contact.** The lead's conversations and identities are re-pointed onto the existing contact and the empty lead is deleted. Agents then see the person's whole history. The visitor's session stays scoped: an unverified session only ever sees conversations whose `originVisitorId` is its own visitor id. Typing an email never unlocks past history. There is no general contact-merge operation in Plunk; this re-point is deliberately narrow: it moves conversations and identities, nothing else.
- **Identified mode (Phase 2, designed now).** The customer's backend signs a short-lived JWT (`sub` = their user id, plus `email` and `name`) with the project's messenger secret. Plunk verifies it, resolves the contact by external id using the existing identify resolution, and issues a verified session that sees all of that contact's conversations. HMAC user hashes (Intercom's legacy method) are not supported: they never expire and cannot carry claims.

### Messenger (widget)

- **New app `apps/widget`** (Preact + Vite) building two artefacts: a loader script under 5 KB and the messenger frame. Served as static assets from our domain; the loader URL is stable, frame assets are content-hashed.
- **Embed.** One script tag carrying the project public key. The loader draws the launcher, owns the first-party visitor cookie, and exposes `PlunkChat('boot' | 'show' | 'hide' | 'update' | 'shutdown', options)`.
- **Standalone mode.** The frame also works as a standalone URL, so a mobile app or a "Contact us" link can open it without the loader.
- **Look and copy.** Accent colour, launcher position, greeting, and team avatars from `MessengerSettings`; name and logo from the project's existing `brandName` / `brandLogoUrl`; language from the project's `language`.
- **Home.** Office hours, expected reply time, and the visitor's previous conversations, with a button to start a new one. Outside office hours the messenger states when the team is back and asks for the email more prominently.

### Realtime

- **Server-Sent Events for pushes, plain HTTP for actions.** One SSE stream per messenger session and one per agent dashboard. Events: new message, conversation updated, typing, read.
- **Redis pub/sub fan-out.** Each API process holds one Redis subscriber and fans out in-process to its open streams, so connections scale with clients without Redis connections scaling with them. Channels are per project (agents) and per conversation (visitors).
- **Resilience.** Heartbeats keep proxies from closing idle streams; events carry ids so a reconnecting client resumes with `Last-Event-ID` and refetches anything missed. The client treats the stream as a hint and the REST API as the truth.
- Typing is a debounced POST that publishes but is never persisted. Read state is persisted (`contactLastReadAt`, `ConversationRead`).

### Messages and attachments

- Text with auto-linked URLs, light formatting (bold, italic, lists, code), and emoji. Bodies are sanitized on write.
- Attachments up to 10 MB in both directions, type-allowlisted. **Stored privately**: the existing upload path writes to `S3_PUBLIC_URL`, which is public, so chat attachments go to a separate private bucket and are only ever served through short-lived presigned URLs (about five minutes) issued to the conversation's session or an authorised agent. Emailed replies link to an authenticated download instead of embedding the file.

### Email loop

- **Delivery.** When an agent comment is still unread by the visitor after a delay (default five minutes), it is emailed through Plunk's existing transactional pipeline, branded with the project, from the project's support address. `In-Reply-To` / `References` headers keep the thread together in the visitor's mail client. A project's `sendingPaused` holds these emails like any other; the message is still delivered in the messenger.
- **Reply domain.** Each project configures a receiving subdomain on one of its verified domains (for example `reply.metacognitivetherapy.com`), with an MX record to SES inbound shown alongside the existing DNS rows in Domain settings. The reply-to is `reply+<replyToken>@<that subdomain>`.
- **Inbound routing.** The SES inbound webhook recognises reply addresses **before** its existing fan-out. That fan-out delivers to every project sharing a domain and upserts the sender as subscribed, both of which would be wrong here. A reply address resolves to exactly one conversation by token.
- **Parsing.** Quoted history and signatures are stripped. Attachments are kept.
- **Sender check.** If the sender matches the conversation's contact, the mail becomes a visitor message and reopens the conversation. Any other sender becomes an internal note flagged "from <address>, unverified", visible only to agents.
- **Billing.** Conversation replies do not count against `billingLimitInbound`.
- **Region.** SES email receiving is available only in some regions. Confirm the configured `AWS_SES_REGION` supports it before building; if not, receiving runs in a supported region with its own receipt rule and SNS topic.

### Inbox

- Views: Unassigned, Mine, All, Closed, plus a tag filter. Cursor-paginated by `lastMessageAt`.
- States: Open, Snoozed (until a date, or until the visitor replies), Closed. A visitor message reopens a closed or snoozed conversation. A sweep wakes snoozed conversations when `snoozedUntil` passes.
- Assignment to any support agent of the project, or unassigned.
- Internal notes with @mentions; a mention notifies the mentioned agent through the same channels as a new message.
- Saved replies inserted from a picker, with Plunk's existing template variables resolved against the contact.
- Conversation tags.
- Right-hand panel: contact data, contact tags, segments, recent events, and other conversations.
- Fully usable at phone width.

### Agent notifications

- **In-app.** Sidebar unread badge, unread count in the tab title, and a sound, each toggleable per agent.
- **Web Push.** A service worker plus VAPID keys. A web app manifest makes the dashboard installable, which is also what enables push on iOS Safari.
- **Email fallback.** When a visitor message has gone unread for N minutes, the assignee (or every support agent, if unassigned) is emailed through platform mail. The delay is per project.
- **Slack.** A per-project incoming webhook. New conversations, and visitor replies on unassigned ones, are posted with a preview and an "Open in Plunk" link. Notify-only; replying from Slack is out of scope.
- Notification fan-out runs in the BullMQ worker, never in the request that created the message.

### Plunk integration

- Reserved events: `conversation.started`, `conversation.replied` (visitor message), `conversation.closed`, `chat.email_captured`. They flow through the existing event pipeline, so workflows and segments react to them like any other event.
- The contact detail page lists the contact's conversations.

### Abuse protection

- **Origin allowlist.** Every messenger request is checked against the project's allowed origins. An empty list means the messenger is disabled, not open.
- **Rate limits** in Redis, per visitor and per IP, for new conversations, messages, uploads, and email capture.
- **Turnstile.** An invisible Cloudflare Turnstile token is required when a conversation starts, verified server-side.

### Retention and erasure

- Anonymizing a contact (the existing anonymize operation) hard-deletes their conversations, messages, and attachment objects.
- A per-project retention period (default 24 months after close) deletes old closed conversations through a scheduled BullMQ sweep, in batches, like the existing email-body cleanup.
- Lead contacts created by the messenger that never gave an email and have been inactive for 90 days are purged.

### Phase 2: React Native SDK

- **`@plunk/react-native`**: JavaScript only, no custom native code, so it works in Expo dev clients without a config plugin. Its surface mirrors `@intercom/intercom-react-native` where noworries uses it (present, show, hide, update user, log event, logout) to make the swap mechanical.
- The messenger UI is built from React Native components on the same messenger API and SSE stream as the web widget.
- **Push.** The app registers an Expo push token, stored as a `push_token` `ContactIdentity` (a vocabulary addition, no migration). Agent replies are pushed through the Expo Push service immediately; the email fallback still applies if the message remains unread.
- **Identity.** noworries' backend mints the identified-mode JWT, so a signed-in user's history follows them across devices and reinstalls.
- **Analytics replacement.** `updateUser` and `logEvent` map to Plunk's identify and track by external id, covering the attributes and events noworries currently sends to Intercom.

### Phase 3: Intercom import

- A one-off import job reads contacts and conversations from the Intercom REST API, resolves contacts through identify (external id first, then email), and writes closed, read-only conversations with `importedFrom` set and their original timestamps. It is idempotent and re-runnable. Its size is estimated against the live Intercom workspace before scheduling.

### Configuration

New environment variables (VAPID keys and subject, Turnstile site and secret keys, the private attachment bucket) follow the repository rule: each one is added to `apps/api/.env.example`, `.env.self-host.example`, and `apps/wiki/content/docs/self-hosting/environment-variables.mdx` in the same change that introduces it.

## Testing Decisions

- Test behaviour through public interfaces: the messenger API, the agent API, and the inbound webhook. Do not test internal helpers.
- **Session scoping** is the highest-value suite: an unverified session never sees a conversation it did not originate, including after its email is re-pointed onto an existing contact. A verified session sees all of the contact's conversations. A token for one project is rejected by another.
- **Access**: every inbox route rejects members without `supportAgent`. Owners are always allowed.
- **Inbound routing**: a reply address reaches exactly one conversation and never triggers the shared-domain fan-out or the subscribing upsert. A different sender becomes a flagged note. Quoted text is stripped. An unknown token is dropped without creating a contact.
- **Consent**: chat-created contacts are unsubscribed unless the visitor opted in. An existing contact's subscription is never changed by chat. Conversation emails still reach unsubscribed contacts and are held by `sendingPaused`.
- **Attachments**: objects are not publicly readable. Presigned URLs are issued only to authorised callers and expire.
- **Retention and erasure**: anonymize removes conversations and attachment objects. The retention sweep deletes only closed conversations past the period, in bounded batches.
- **Realtime**: a message published on one API instance reaches a stream held by another (two subscribers on one Redis). A reconnect with `Last-Event-ID` receives missed events.
- **Performance**: inbox list queries are checked with `EXPLAIN ANALYZE` against a seeded project with many conversations and a large contact table. Follow the CLAUDE.md rule on never running two vitest invocations at once.
- The widget is verified in a real browser on a page served from a different origin, including Safari's storage restrictions.

## Out of Scope

- Help-centre articles and article search in the messenger.
- Support reporting and CSAT. Timestamps and system messages are stored so a reporting slice can backfill later.
- Two-way Slack (replying from Slack).
- A cross-project unified inbox.
- Proactive or outbound messages opened by workflows (Intercom "Outbound").
- AI answers or bots.
- A native agent app; agents use the responsive, installable dashboard.
- A general contact-merge operation. Only the narrow re-point described above is built.
- Recognising an anonymous visitor across different websites.
- ntfy notifications for chat.

## Further Notes

These decisions were reached in a structured design interview covering the goal relative to Intercom, visitor identity, offline delivery, inbox scope, realtime transport, notification channels, Slack depth, inbox workflow, message content, widget architecture, abuse protection, consent, messenger features, Plunk integration, email-match semantics, retention, the reply domain, inbox access, reporting, mobile agents, the noworries migration, identified mode, analytics replacement, attachment storage, inbound sender handling, and history import.

Several decisions came from what the code already does rather than from preference:

- The SES inbound handler fans out to every project that shares a verified domain and upserts the sender as subscribed. That is right for generic inbound mail and wrong for a conversation reply, which is why reply addresses are routed by token before it.
- Uploads are stored under a public URL. That is fine for email images and unacceptable for files a visitor attaches to a support conversation, which is why chat gets a private bucket.
- Transactional sends are already exempt from the subscription flag. That is what lets chat contacts be created unsubscribed without breaking reply emails.
- `ContactIdentity` and its `anonymous_id` type were built for web visitors and had no consumer. The messenger is that consumer, and `push_token` is the planned vocabulary addition for Phase 2.
- There is no contact-merge operation. Merging was explicitly deferred in the contact-identity PRD, which is why the email-match path is a narrow re-point of conversations and identities only.
- Plunk has no organisation model, and one instance serves two organisations. That forces per-project inboxes, per-project reply domains, and messenger branding taken from the project's brand fields.

The visitors of these sites may disclose health information in a chat. That shaped four decisions: the support-agent flag, private attachments, retention with erasure, and the refusal to unlock history from an unverified email. None of these should be relaxed without revisiting that premise.
