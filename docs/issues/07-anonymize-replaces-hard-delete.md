# Issue: Anonymize replaces hard delete

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

Replace contact deletion with anonymization, everywhere, with no remaining destructive path.

Two facts force this. First, unsubscribe and manage links embed the contact id and persist in inboxes that have already received them, including in the one-click unsubscribe header — so deleting a contact that has ever been mailed breaks one-click unsubscribe for every message it already received. That is a compliance and deliverability failure, not a cosmetic one. Second, the email relation cascades on delete, which destroys the send records the denormalized campaign counters were computed from while leaving those counters in place, so reported numbers drift from reality permanently.

Anonymize nulls the email, clears contact attributes, strips personal payloads from that contact's events, and sets the anonymized marker. The row and its send history stay. An anonymized contact is permanently unreachable — the reachability predicate from the leads slice already excludes it — and uncounted.

Anonymization is addressable by external id, so a product's account-deletion hook does not need to know Plunk's internal ids.

The destructive path is **removed, not supplemented**. Every entry point that currently destroys a contact resolves to anonymize instead: the contact service method, the dashboard delete action and its bulk equivalent, the contact API, and the MCP contact tool. No flag, no "actually delete" escape hatch — a single use breaks unsubscribe compliance, and an escape hatch is a bulk action away from being used. The dashboard copy still reads as deletion to the marketer, because permanently unreachable and uncounted is what they mean by it.

## Acceptance criteria

- [ ] Anonymizing a contact nulls the email, clears contact attributes, strips personal payloads from its events, and sets the anonymized marker.
- [ ] The contact row and its send history survive anonymization; campaign counters are unchanged by it.
- [ ] An anonymized contact is never selected into an audience, never enrolled, and never sent mail by any path.
- [ ] An anonymized contact is excluded from the mailable contact count.
- [ ] Unsubscribe and manage links issued before anonymization continue to resolve.
- [ ] Anonymization can be triggered by external id as well as by contact id.
- [ ] No code path anywhere destroys a contact row: the service method, dashboard single and bulk actions, contact API, and MCP tool all resolve to anonymize.
- [ ] Re-anonymizing an already-anonymized contact is a no-op rather than an error.
- [ ] Wiki documents that deletion is anonymization and why.

## Blocked by

- `docs/issues/01-leads-contacts-without-email.md`
