# Issue: Identified mode (signed user tokens)

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Phase 2 foundation.

- A per-project messenger secret, generated and rotatable in Messenger settings.
- `boot` accepts a JWT signed by the customer's backend with that secret: `sub` (their user id), optional `email` and `name`, and `exp` (at most one hour ahead).
- Plunk verifies the token, resolves the contact through the existing identify resolution (external id first, then email; the conflict refusal applies), and issues a **verified** session that sees every conversation of that contact.
- Any anonymous conversations started in the same browser before sign-in are re-pointed onto the identified contact, under the narrow rule from issue 13.
- The loader and the frame accept the token through `PlunkChat('boot', {userToken})`.

## Acceptance criteria

- [ ] A valid token yields a verified session that lists all the contact's conversations, including ones from other devices.
- [ ] A token with a bad signature, an expired `exp`, or another project's secret is refused.
- [ ] Rotating the secret invalidates tokens signed with the old one.
- [ ] An email/external-id conflict is refused, never merged.

## Blocked by

- `docs/issues/13-email-capture-and-consent.md`

## User stories

41, 44
