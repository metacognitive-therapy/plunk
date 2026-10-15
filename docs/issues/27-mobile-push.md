# Issue: Push notifications for mobile messenger replies

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Add `push_token` to the `ContactIdentity` type vocabulary in `@plunk/shared`. This is a vocabulary change with no migration.
- The SDK registers an Expo push token for the identified contact. The host app owns the permission prompt and passes the token in.
- When an agent comments, a worker job pushes to the contact's tokens through the Expo Push service straight away. The email fallback from issue 18 still applies if the message stays unread.
- Expo receipts are checked. Tokens reported as invalid are removed.
- Tapping the notification opens the conversation (the SDK exposes a handler the host app wires to its notification listener).

## Acceptance criteria

- [ ] An agent reply produces a push on the user's device. Tapping it opens the conversation.
- [ ] An invalid token is removed after its receipt reports it.
- [ ] Anonymizing the contact removes its push tokens.
- [ ] Nothing is pushed for internal notes.

## Blocked by

- `docs/issues/26-react-native-sdk.md`

## User stories

43
