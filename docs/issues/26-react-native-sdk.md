# Issue: React Native messenger SDK

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

A new package, `@plunk/react-native`, JavaScript only, with no custom native code.

- A provider configured with the API URL and the project public key, plus a messenger UI built from React Native components: home, conversation list, thread and composer. It runs on the same messenger API and SSE stream as the web widget.
- The API mirrors the parts of `@intercom/intercom-react-native` that noworries uses: `present`, `hide`, `loginUserWithUserAttributes` / `logout` (backed by identified mode), and an unread-count listener.
- Attachments go through the device's image picker when the host app provides one; the SDK accepts a picker callback rather than depending on one.
- A small example app in the package exercises it.

## Acceptance criteria

- [ ] The SDK installs into an Expo dev client without a config plugin or a native rebuild beyond what the host app already has.
- [ ] A signed-in user can open the messenger, see their full history, send a message, and receive the agent's reply live.
- [ ] The unread-count listener fires when an agent replies while the messenger is closed.
- [ ] `logout` clears the session, and the next user does not see the previous user's conversations.

## Blocked by

- `docs/issues/12-realtime.md`
- `docs/issues/25-identified-mode.md`

## User stories

42, 45
