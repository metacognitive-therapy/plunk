# Issue: Contact identities

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

A place for the identifiers that are genuinely many-per-person.

Email and external id stay as columns on the contact, because they are one-per-person and every hot query filters or joins on them. Everything else — anonymous web identifiers today, analytics distinct ids, device push tokens later — moves into a namespaced child table: a type, a value, and a last-seen timestamp, unique on project plus type plus value.

The purpose is that the same person on two devices does not become two contacts, and that adding the push channel later requires no further migration. This slice deliberately builds the table and its surface only; nothing consumes it yet, since web-guest ingestion and the push channel are both out of scope for this PRD.

Contact detail shows the identifiers held against a contact, so an operator can confirm which person a record refers to.

## Acceptance criteria

- [ ] A namespaced contact-identity table exists as a child of contact, unique on project, type, and value.
- [ ] The type vocabulary covers anonymous identifiers and analytics distinct ids, and is extensible to push tokens without a schema migration.
- [ ] Several identities can be recorded against one contact, and the same value under two different types does not collide.
- [ ] Identities are visible on the contact detail page alongside the external id.
- [ ] Anonymizing a contact removes or neutralises its identities, so an anonymized record holds no identifying value.
- [ ] Identities are exposed through the MCP contact tools.
- [ ] Email and external id remain columns on contact and are not migrated into this table.

## Blocked by

- `docs/issues/01-leads-contacts-without-email.md`
