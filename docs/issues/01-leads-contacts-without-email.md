# Issue: Leads — a contact can exist without an email address

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

The foundational slice: make a Contact a person rather than a mailbox, and make the platform structurally incapable of mailing one that has no address.

A contact's email becomes optional. A new project-scoped stable external id is added, and a marker for anonymized records. A contact with no email is a **lead**: it can be tagged, segmented, and tracked exactly like any other contact, but it is never selected into an audience and never receives mail.

Lead-versus-user is **derived, never stored**. No role or type column is introduced. *Identified* means an external id is present; *email-reachable* means an email is present, the contact is subscribed, and it is not anonymized. Widen the shared predicate from the prefactor slice to carry the full definition, so all four send sites inherit it at once.

`POST /v1/identify` arrives in this slice in its simplest form only: given an external id and no email, it creates a lead. All the resolution and binding cases are the next slice — this one only needs enough of the endpoint to put a lead into the system and prove the guards hold.

The dashboard must make the distinction visible, because a marketer who cannot see that a contact is unreachable will treat the audience count as wrong rather than as correct-and-filtered.

This slice is deliberately not split. A nullable email column merged ahead of the guards that respect it is a live hazard sitting on the default branch: any contact row with a null email would flow into a campaign audience. Schema, guards, and surface land together or not at all.

## Acceptance criteria

- [ ] Contact email is nullable; the project-and-email uniqueness constraint is retained and multiple leads coexist under it without collision.
- [ ] A nullable external id exists with a project-scoped unique constraint, and a nullable anonymized-at marker exists.
- [ ] Identified and email-reachable are computed from column state; no role, type, or `isLead` column is added anywhere.
- [ ] `POST /v1/identify` accepts an external id with no email and creates a lead.
- [ ] A lead can be tagged and can match a segment on the same terms as any other contact.
- [ ] A lead is never selected into a campaign audience, never enrolled into or sent by a sequence, and is refused by both email-send guards.
- [ ] The campaign recipient-count preview reflects the exclusion, so the previewed number equals the number actually sent.
- [ ] The dashboard contact list marks leads distinctly, and the headline contact count separates mailable contacts from leads.
- [ ] Contact-count reporting and available-field reporting no longer assert that every contact has an email.
- [ ] Partial indexes support the reachability predicates.
- [ ] Wiki documents the lead concept.

## Blocked by

- `docs/issues/00-extract-mailable-contact-predicate.md`
