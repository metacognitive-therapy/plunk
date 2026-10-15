# Issue: In-app notifications, Web Push and the installable dashboard

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- **In-app.** An unread badge on the Inbox navigation item, an unread count in the tab title, and a sound on new visitor messages. All three update live from the agent stream, across every project the agent supports. Each can be toggled per agent.
- **Web Push.** VAPID keys (new environment variables), a service worker, a `WebPushSubscription` per user and device, and an opt-in prompt in agent settings. A visitor message or a mention pushes to the assignee, or to every support agent when unassigned. Fan-out runs in the worker. Expired subscriptions are pruned.
- **Installable dashboard.** A web app manifest and icons that follow the project brand where possible, so the dashboard can be installed on a phone (which is what enables push on iOS).
- **Responsive Inbox.** The list and thread views are fully usable at phone width.
- The new environment variables are added to all three env files.

## Acceptance criteria

- [ ] With the dashboard open on another page, a new visitor message updates the badge and the title and plays the sound.
- [ ] With the dashboard closed, an opted-in agent receives a desktop notification that opens the conversation.
- [ ] The dashboard installs to a phone home screen and receives push there.
- [ ] Only support agents of the conversation's project are notified.
- [ ] The Inbox works at 375 px width with no horizontal scroll.

## Blocked by

- `docs/issues/12-realtime.md`

## User stories

14, 15, 18
