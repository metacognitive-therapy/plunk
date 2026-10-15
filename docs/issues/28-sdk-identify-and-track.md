# Issue: SDK identify and track (Intercom analytics replacement)

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- The SDK's `updateUser(attributes)` and `logEvent(name, data)` stand in for Intercom's.
- Both are authenticated with the identified-mode session, never with a secret key shipped in the app. A new messenger-session-authenticated endpoint forwards to identify and to track by external id.
- Attributes go through identify's bounded, declared attribute set. Undeclared attributes are refused with a clear error, so the GIN-indexed attribute space stays finite.
- Events go through track by external id, with an optional occurrence time.
- A mapping table in the wiki lists noworries' current Intercom attributes and events next to their Plunk equivalents.

## Acceptance criteria

- [ ] `logEvent` from the app records an event on the identified contact, and a workflow on that event runs.
- [ ] `updateUser` updates declared attributes and refuses undeclared ones.
- [ ] Neither call works from an unverified (anonymous) session.
- [ ] No secret key is needed in the app.

## Blocked by

- `docs/issues/26-react-native-sdk.md`

## User stories

46
