# Issue: Track by external id

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

Let `POST /v1/track` accept a stable external id in place of an email, so a product can record behaviour without first resolving an address.

The security property is the point of this slice, not a side condition. The public key that authorises track carries no origin restriction and is extractable from any client that holds it. On the external-id path the endpoint therefore **resolves an existing contact and never creates one** — so possession of a leaked key cannot be used to conjure contacts for email addresses of the caller's choosing and then mail them. An unknown external id returns a distinguishable not-found, so an integration can tell "this user isn't in Plunk" from "your request was malformed", rather than having events silently vanish.

Email and external id are mutually exclusive in the request schema. The external-id path never accepts a subscription state — consent changes go through identify only, so recording behaviour can never re-subscribe someone who opted out. The existing email path is untouched, so current integrations keep working.

Event `data` remains non-persistent on this path: it is recorded on the event and available to workflows, but is not merged onto the contact.

## Acceptance criteria

- [ ] Track accepts an external id, resolves the matching contact, and records the event against it.
- [ ] Passing both an email and an external id is rejected by the request schema.
- [ ] An unknown external id never creates a contact and returns a distinguishable not-found response.
- [ ] The external-id path rejects or ignores any subscription field; consent is unchanged by tracking.
- [ ] Tracking against a lead works — a lead accumulates events like any other contact.
- [ ] Event data is not merged onto the contact's persistent attributes.
- [ ] The existing email-keyed track path behaves exactly as before.
- [ ] Contacts can be looked up and filtered by external id in the dashboard, and the MCP contact tools expose external id and lead state.
- [ ] API reference documents the external-id track path and its non-creating guarantee.

## Blocked by

- `docs/issues/02-identify-resolution-and-binding.md`
