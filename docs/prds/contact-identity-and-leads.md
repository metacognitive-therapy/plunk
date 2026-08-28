# PRD: Contact Identity and Leads

Status: ready-for-agent
Date: 2026-08-27

## Problem Statement

As a Plunk user I can only identify a contact by their email address, and that single assumption blocks three things I need.

First, I cannot represent a person before I know their email. My app lets people use it as a guest before signing up, and those people are invisible to Plunk — I cannot tag them, segment them, record what they did, or reach them the moment they finally give me an address. Everything they did before signing up is lost, so a converted user always looks brand new.

Second, when a contact changes their email address, Plunk creates a *second contact*. The old record keeps their tags, their position in a sequence, their event history, and their send history, while the new record starts from nothing. A contact halfway through an onboarding sequence silently stops progressing and begins again as a stranger. This is a live defect today, independent of any new feature.

Third, I cannot drive messaging from my product's behaviour, because my app knows users by a stable user id and Plunk only understands email addresses. To send an event I have to resolve an email first, which means either shipping an API key into my mobile app (where anyone can extract it and trigger sends to addresses of their choosing) or building a resolution layer that Plunk should own.

Alongside those, three smaller gaps bite as soon as behavioural events start flowing. I have no authoritative place for email consent, so an in-app preferences toggle and a one-click unsubscribe from a delivered message can each silently overwrite the other. Event recency is measured from when Plunk *received* an event rather than when it happened, so a segment for "finished a module in the last 7 days" is wrong whenever delivery lags. And I have no way to stop sending without also stopping ingestion, so my only emergency brake throws away the events I would need to recover.

## Solution

Make a Contact a *person* rather than a mailbox.

- A contact's email becomes optional, and a new stable external id — the identifier my product already uses for that user — becomes the durable key. A contact with no email is a **lead**: fully tagged, segmented, and tracked, but never mailed.
- A new namespaced identity table holds the identifiers that are genuinely many-per-person: anonymous web ids today, device push tokens later. Email and external id stay first-class columns because every query touches them.
- A new `POST /v1/identify` endpoint is the authoritative place to bind an external id to an email, set consent, and update declared person attributes. It is the only path that writes contact attributes.
- `POST /v1/track` accepts an external id in place of an email. On that path it resolves an existing contact and **never creates one**, so a leaked public key cannot be used to conjure contacts for arbitrary addresses.
- Whether a contact is a lead or a known user is *derived*, never stored: identified means it has an external id, email-reachable means it has an email and is subscribed. Reachability stays correct per channel as new channels arrive.
- Every send path gains one more condition alongside the subscription check it already performs: a contact with no email, or one that has been anonymized, is never selected into an audience and never receives mail.
- Events gain a separate occurrence timestamp, and recency queries use it, so late-arriving events land in the right window.
- Account deletion anonymizes rather than deletes: the email and all personal payloads are stripped and the row is marked deleted, preserving send history and campaign counters while ceasing to be personal data.
- A project-level sending pause halts every send within seconds while ingestion, workflows, and sequences keep running — an emergency brake that loses nothing.
- Because high-volume behavioural events are now expected, the workflow trigger lookup gains a cache of the event names anything actually reacts to, so the overwhelming majority of events cost one cache read and one insert.

## User Stories

1. As a developer, I want to identify a contact by the stable user id my product already uses, so that I do not have to resolve an email address before I can record behaviour.
2. As a developer, I want a single identify call that binds a user id to an email address, so that identity has one authoritative entry point instead of being a side effect of event tracking.
3. As a developer, I want identify to be safe to call repeatedly, so that my retries converge on the same state instead of creating duplicates or erroring.
4. As a developer, I want to create a contact that has no email address at all, so that I can represent a guest who is using my product before signing up.
5. As a developer, I want a guest contact to gain an email address later without losing anything, so that conversion preserves their tags, history, and sequence position.
6. As a marketer, I want a contact who changes their email address to remain the same contact, so that their sequence position, tags, and history survive the change.
7. As a marketer, I want to see at a glance whether a contact is a lead or a known user, so that I understand who I can actually reach.
8. As a marketer, I want leads to be excluded from every campaign audience automatically, so that I never have to remember to filter them out.
9. As a marketer, I want a recipient count preview to reflect that exclusion, so that the number I see before sending is the number that will receive it.
10. As a marketer, I want to tag and segment leads exactly like any other contact, so that I can build an audience for them ahead of the moment they become reachable.
11. As a marketer, I want a lead to enter the relevant sequences and campaigns automatically the moment they gain an email address, so that conversion does not require manual work.
12. As a marketer, I want the dashboard contact count to distinguish mailable contacts from leads, so that my headline number is not inflated by people I cannot email.
13. As a marketer, I want to search and filter contacts by their external id, so that I can find the Plunk record for a user I am looking at in my own product.
14. As a marketer, I want a contact's external id and other identifiers visible on their detail page, so that I can confirm which person a record refers to.
15. As a developer, I want to record several anonymous identifiers against one contact, so that the same person using two devices does not become two contacts.
16. As a developer, I want tracking by external id to refuse to create a contact, so that a leaked public key cannot be used to inject contacts for email addresses I did not choose.
17. As a developer, I want a clear, distinguishable response when I track against an unknown external id, so that my integration can tell "unknown user" from "bad request".
18. As a developer, I want to send an event's occurrence time along with the event, so that a delayed or retried delivery is still recorded in the right window.
19. As a marketer, I want event recency conditions in segments to use when the event happened, so that "in the last 7 days" means what I think it means.
20. As a marketer, I want the ingestion time preserved separately, so that I can still diagnose delivery lag when something looks wrong.
21. As a developer, I want consent to live in exactly one place, so that a preferences toggle in my app and a one-click unsubscribe from an email cannot silently overwrite each other.
22. As a developer, I want to read and write a contact's subscription state through the API, so that my product's own settings screen can present it as the single truth.
23. As a developer, I want event tracking to leave consent untouched unless I explicitly change it, so that recording behaviour can never re-subscribe someone who opted out.
24. As an end user, I want my unsubscribe to be permanent, so that continuing to use the product does not opt me back into marketing email.
25. As an operator, I want to pause all sending for a project instantly, so that I can stop a mistake without waiting for a deploy.
26. As an operator, I want ingestion, workflows, and sequences to keep running while sending is paused, so that nothing is lost and I can resume once the problem is fixed.
27. As an operator, I want a paused send to be recorded as suppressed rather than failed, so that I can see exactly what would have gone out.
28. As an operator, I want the emergency brake to be distinct from disabling a project, so that stopping sends does not also stop events arriving.
29. As an end user, I want my personal data removed when I delete my account, so that my identity is no longer held.
30. As an operator, I want deletion to strip the email and every personal payload while keeping the send record, so that my campaign statistics stay coherent after a deletion.
31. As an operator, I want an anonymized contact to be permanently unreachable and uncounted, so that a deleted user can never be mailed again.
32. As a marketer, I want the delete action in the dashboard to do the safe thing by default, so that I cannot break unsubscribe links or my own campaign statistics by clicking a button.
33. As an operator, I want no remaining way to destroy a contact that has been mailed, so that one careless bulk action cannot cause a compliance failure.
34. As a developer, I want to trigger anonymization by external id, so that my product's account-deletion hook does not need to know Plunk's internal ids.
35. As an operator, I want deletion to avoid cascading away the history that campaign counters were computed from, so that reported numbers do not drift from reality.
36. As a marketer, I want to send high-volume behavioural events without slowing the platform down, so that I can target on real product behaviour rather than a curated handful of milestones.
37. As a marketer, I want an event that no workflow reacts to yet to still be recorded, so that I can build an automation on it later without having registered it in advance.
38. As a marketer, I want a workflow I build on an existing event name to start firing immediately, so that I never have to wonder whether an event was "enabled".
39. As a developer, I want a reserved event emitted when a lead becomes identified, so that I have one predictable hook for conversion messaging.
40. As a marketer, I want conversion not to trigger a burst of automations from tags earned earlier, so that a new user is not flooded the moment they sign up.
41. As a developer, I want the identify endpoint to refuse rather than guess when an email address already belongs to a different identified user, so that two people's subscriptions are never silently merged.
42. As a developer, I want identify to bind cleanly onto an existing contact that has no external id yet, so that contacts already in Plunk adopt their user id on first call.
43. As an operator, I want the platform to refuse to mail an unreachable contact regardless of which caller recorded the event, so that a bug in an integration cannot become a misdirected send.
44. As a self-hoster, I want the new behaviour documented in the wiki, so that I can configure and reason about it without reading the source.
45. As a developer, I want the MCP tools to expose identity and lead state, so that I can inspect and manage contacts through the same interface as everything else.

## Implementation Decisions

- **Contact schema changes.** `Contact.email` becomes nullable; the existing project-and-email uniqueness is retained (Postgres permits multiple nulls in a unique index, so leads do not collide). A nullable `externalId` is added with a project-scoped unique constraint. A nullable `deletedAt` marks anonymized rows. No `role` or `type` discriminator is introduced — lead versus user is derived from the presence of `externalId` and `email` (see *Derived reachability*).

- **New `ContactIdentity` model.** Child of `Contact`, holding a type (`ANONYMOUS`, `POSTHOG_DISTINCT_ID`, and later `PUSH_TOKEN`), a value, and a last-seen timestamp, unique on project plus type plus value. Email and external id deliberately remain columns on `Contact` rather than moving here, because they are one-per-person and every hot query filters or joins on them; only genuinely many-per-person identifiers live in the child table. This is the extension point for the push channel later, so no further migration is needed then.

- **Derived reachability, not a stored role.** *Identified* means `externalId` is present. *Email-reachable* means `email` is present, `subscribed` is true, and `deletedAt` is null. These are computed in the query layer, expressed as reusable Prisma where-fragments so all four send chokepoints share one definition. Reachability is per-channel by construction, so adding push does not require revisiting this decision. Partial indexes support the predicates.

- **`POST /v1/identify` (new, secret key).** Accepts an external id, an optional email, optional declared attributes, an optional explicit subscription state, and optional tags. Resolution order: by external id first, then by email. Behaviour by case:
  - Neither found → create the contact. Subscription state is taken from the request; when absent, the existing default applies.
  - Found by external id → update, including adopting a changed email address on the same row. This is what fixes the email-change defect.
  - Found by email with a null external id → **bind** the external id onto that existing contact. This is the primary path for every contact already in Plunk, not an edge case.
  - Found by email with a *different* non-null external id → refuse with a conflict error. Silently moving a subscription between two identified people is never correct.
  - Identify is the **only** path permitted to write persistent contact attributes.

- **`POST /v1/track` accepts an external id.** Mutually exclusive with email in the request schema. On the external-id path the endpoint resolves an existing contact and never creates one; an unknown external id returns a distinguishable not-found rather than being silently dropped. The external-id path never accepts a subscription state — consent changes go through identify. The email path is unchanged, preserving backward compatibility for existing integrations.

- **Attribute persistence policy.** Event `data` on the track path is treated as non-persistent by default: values are available to workflows and recorded on the event, but are not merged onto the contact. A bounded, declared set of person attributes is written only by identify. This keeps the JSON attribute space finite (it is GIN-indexed and drives segmentation) and keeps every attribute meaning *current state* rather than "value at the time of the last event that happened to carry it".

- **Send chokepoint guards.** The campaign audience query, the sequence enrolment and send query, and both email-send guards each gain the email-reachable predicate alongside the subscription check they already perform. These four points are the platform's own backstop: no matter which integration recorded an event, an unreachable contact cannot be mailed. Contact-count and available-field reporting are corrected in the same change, since both currently assert that email is present on every contact.

- **Event occurrence time.** `Event` gains `occurredAt`, defaulting to now so existing callers are unaffected, and settable by the caller. Only the *recency predicates* switch to it: the segment conditions for "triggered since" and "triggered older than", and the equivalent campaign-audience filters. Everything that is genuinely about ingestion stays on `createdAt` — the contact and project event feeds, and event statistics over a date range — because those answer "what did Plunk receive, and when" and are the tool for diagnosing delivery lag. The composite index serving event-based segment queries is therefore *extended* rather than repointed, so the feed's ordering remains indexed; whether `createdAt` can be dropped from it is a question for the query plans at real volume, not a decision to make in advance. Index count on the highest-volume table must not grow unbounded — if the plans show the extended index is enough for both, consolidate.

- **Anonymization instead of deletion.** A new anonymize operation, addressable by external id, nulls the email, clears contact attributes, strips personal payloads from that contact's events, and sets `deletedAt`. The row and its send history are retained. Hard deletion is deliberately not used because the email relation cascades, which would destroy the records that the denormalized campaign counters were computed from while leaving those counters in place.

- **Hard delete is removed, not merely supplemented.** Anonymization is not an additional option alongside the existing delete — it *replaces* it. Every entry point that currently destroys a contact resolves to anonymize instead: the contact service's delete method, the dashboard's delete action and its bulk equivalent, the contact API, and the MCP contact tool. The destructive path does not survive behind a flag or an "actually delete" escape hatch, because a single use of it breaks one-click unsubscribe for every message that contact has already received and silently decouples the campaign counters from the rows they were computed from. The dashboard copy changes accordingly: the action still reads as deletion to the marketer and still makes the contact permanently unreachable and uncounted, which is what they mean by it.

- **Reserved events.** `contact.identified` is added to the reserved set (it may not be tracked manually) and is emitted once when a lead gains an email address. Any tag or attribute movement that happens as part of an identify or anonymize operation writes directly rather than going through the event-emitting tag path, because applying a tag emits `tag.added`, which routes into sequence auto-enrolment — a conversion would otherwise enrol a brand-new user into every sequence bound to every tag they earned as a guest.

- **Trigger-name cache.** The existing Redis cache of enabled workflows is extended to hold the set of event names any enabled workflow triggers on, plus a flag for whether the project has any wait-for-event step at all. Event tracking consults this before running the workflow trigger evaluation and the waiting-execution lookup, and skips both when nothing can match. The existing cache-invalidation hook is extended to cover the new entries. Semantics are unchanged — every event remains capable of triggering a workflow the moment one is built — so no event registry or allowlist is introduced, and no workflow can silently fail to fire.

- **Project sending pause.** A new project-level flag, distinct from the existing disabled state. The email processor checks it where it already checks the project's disabled state and marks the email row suppressed rather than cancelled or failed. Critically, the pause is *not* consulted by the authentication middleware, so ingestion, workflow execution, and sequence progression continue while it is set — unlike the disabled state, which rejects incoming requests and would therefore discard the events needed to recover.

- **Delivery and idempotency contract.** Documented for integrators rather than changed in the platform: identify should be called without an idempotency key, because it is convergent and a retry is desirable; event tracking should use a key derived from the semantic occurrence, and should treat a conflict response as already-delivered. The existing fail-closed idempotency behaviour (a reused key is refused rather than replayed, and the claim is retained on server error) is left intact.

- **Surface.** Contact detail and contact list gain identity display and a lead indicator; contact list gains filtering by lead state and lookup by external id. The MCP contact tools expose external id, identities, and lead state, and gain the identify and anonymize operations. The sending pause is a per-project setting surfaced in project settings, not an environment variable — it must be flippable for one project without a redeploy, and self-hosters run multiple projects in one deployment. No environment variable is added or changed by this PRD; if implementation finds one is unavoidable, the project's three-file rule applies and all three must be updated in the same change. The wiki documents the pause, the lead concept, and the anonymize-on-delete behaviour, and the API reference documents identify and the external-id track path.

- **Refactor posture.** The fork is now formally independent of upstream, so `ContactService` and `EventService` are refactored directly to accommodate identity resolution rather than having parallel methods added alongside the existing ones to preserve mergeability.

## Testing Decisions

A good test here asserts externally observable behaviour — the API response, the resulting database state, whether an email row was created and whether it was sent — and never internal call counts, private methods, or the shape of intermediate objects. This matches the existing convention across the suite. Tests run against a real, per-worker isolated Postgres using the shared factories, so no Prisma mocking is introduced.

Seams, highest existing first. No new seam is created.

- **Integration seam (primary).** Extend the existing actions integration test, which already covers the request-schema-plus-service-layer surface of `/v1/track`. This is the highest seam the repo has and the right home for the whole public contract: identify creating a lead with no email; identify binding an external id onto a contact that has none; identify adopting a changed email on the same contact row; identify refusing with a conflict when an email belongs to a different identified contact; tracking by external id resolving an existing contact; tracking by external id refusing to create one and returning a distinguishable not-found; the external-id path leaving consent untouched; and the mutual exclusivity of email and external id in the request schema. Prior art: the tags and campaigns integration tests, which follow exactly this pattern.

- **`ContactService` seam.** Extend the existing contact service tests for the invariants that are cheaper to state directly than through the API: null-email contacts coexisting under the email uniqueness constraint, project-scoped external-id uniqueness, derived reachability across the full matrix of email present/absent, subscribed true/false, and `deletedAt` set/null, and anonymization stripping attributes and event payloads while retaining the send history.

- **`EventService` seam.** Extend the existing event service tests, which already have dedicated tag and sequence variants. Cover `occurredAt` defaulting and caller override; recency queries reading occurrence time rather than ingestion time; `contact.identified` being reserved and emitted exactly once on conversion; identify-time tag and attribute movement *not* emitting `tag.added` and therefore not auto-enrolling; and the trigger-name cache short-circuiting, asserted behaviourally by confirming a workflow does not advance for a non-matching event while still advancing for a matching one. The existing Redis mock supports the cache cases.

- **Send chokepoint seam (highest value).** Extend the existing campaign, opt-out, sequence, and email service tests with the same invariant stated four times, once per chokepoint: a contact with a null email, and a contact with `deletedAt` set, is never selected into an audience, never enrolled, and never sent a marketing email — while an equivalent reachable contact is. The opt-out test file is the closest prior art, since it already asserts this shape for the subscription flag.

- **Job seam.** Extend the existing email processor test: with sending paused the email row is marked suppressed rather than cancelled or failed, and unpausing allows a subsequent send. Also assert that a paused project still ingests events and advances workflows, which is the behaviour that distinguishes the pause from the disabled state.

- **Performance seam.** Add to the existing performance suite an assertion that per-event cost stays flat as the number of event names grows when no workflow reacts to them, guarding the trigger-name cache against regression. Prior art: the existing workflow-execution performance test.

## Out of Scope

- **Merging two contacts.** Deferred deliberately. Because the identifier the app uses survives its own anonymous-to-permanent conversion, an in-app guest becoming a user is an update to one row, not a merge. Merging is only required for cross-device web guests and is a separate piece of work, including composite-key conflict resolution across the tag, segment-membership, sequence-subscription and sequence-step-send tables, and repair of the denormalized member counts.
- **Web guest ingestion.** The first-party cookie identifier, the edge ingestion endpoint, and passing that identifier into the app at signup all live outside this repo.
- **The push channel.** Storing device tokens, a push sender, a push queue, and per-channel consent. The identity table is shaped to accept push tokens without further migration, but nothing push-related is built here.
- **In-app messaging.**
- **Outbound webhooks.** The platform remains inbound-only. This is why consent is modelled as single-owner rather than synchronised.
- **Migration and backfill of existing contacts.** Explicitly deferred by the product owner. Contacts already in Plunk adopt their external id lazily through the identify bind path.
- **Everything on the emitting side.** The reconciler that watches product state and calls this API, the shared client package that owns the allowlist and retry policy, the mobile app's analytics provider, and the edge worker are all in other repositories and get their own PRDs.
- **Importing the incumbent platform's suppression list.** An operational prerequisite of the cutover, not a change to this codebase.
- **Cross-system delivery reconciliation.** No job comparing platform event counts against the analytics provider. Observability for the cutover is limited to existing platform metrics.
- **Any change to the fail-closed idempotency behaviour.** The contract is documented for integrators; the middleware is untouched.
- **Any change to workflow or sequence execution semantics.** This PRD adds an identity layer beneath them and a cache in front of the trigger lookup; neither engine's behaviour changes.

## Further Notes

These decisions were reached through a structured design interview covering the platform's role relative to the incumbent messaging tool, channel sequencing, the identity model, lead representation, merge semantics and direction, anonymous identifier sourcing, transport, consent ownership, fork posture, event naming, emission points, delivery guarantees, lead creation policy, deletion, attribute persistence, event timing, cutover strategy, the emergency brake, per-event cost, client ownership, and observability.

Several decisions were forced by constraints found in the code rather than chosen freely, and are worth preserving as rationale:

- Unsubscribe and manage links embed the contact id and persist in already-delivered inboxes, including in the one-click unsubscribe header. Deleting a contact that has ever been mailed therefore breaks one-click unsubscribe for every message it already received — a compliance and deliverability failure, not a cosmetic one. This is what forces anonymization over deletion, and it fixes merge direction unambiguously wherever merging is eventually built: the survivor is always the record that has been mailed.
- Applying a tag emits an event that routes into sequence auto-enrolment, which is why identity operations must write tag and attribute changes directly rather than through the normal tagging path.
- The project disabled state rejects incoming requests, not just sends, which is why a separate sending pause is required and why the disabled state cannot serve as a shadow or brake mode.
- The public key carries no origin restriction, which is why the external-id track path must be non-creating and why no key belongs in a client application.
- The waiting-execution lookup runs on every event regardless of whether any workflow uses a wait-for-event step, which is what makes the trigger-name cache a prerequisite for high-volume behavioural events rather than an optimisation.

Two decisions carry accepted risk that the product owner took knowingly, recorded here so it is not rediscovered as a surprise. Cutover is a single-date switch with no shadow period, and observability is limited to existing platform-side metrics. Together these mean a partial ingestion failure — one event type quietly not arriving — is indistinguishable from low user activity, and the sending pause is the only instrument available on the cutover day. Sizing the public track rate limit against real daily-active numbers remains open and should be done before a date is chosen.

An alternative was considered and rejected: another project in the same organisation already implements a contact spine with a namespaced identity model, a single contact-resolution entry point, an append-only audit log, and a typed attribute registry, but has no automation engine. Building the identity layer here was chosen instead because this platform is already deployed and already owns the workflow and sequence engine this integration exists to drive. The accepted cost is reimplementing identity semantics that project had already solved, in a fork maintained without upstream support. Its records on namespaced identity and on treating an email change as an added identity rather than a replaced one are useful prior art for this implementation.
