# Issue: Embeddable messenger and appearance

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Turn the standalone messenger into something a site owner pastes into Webflow.

- A loader script of under 5 KB, built from `apps/widget`, served from a stable URL. It draws the launcher, mounts the messenger frame in an iframe, and exposes `PlunkChat('boot' | 'show' | 'hide' | 'update' | 'shutdown', options)`.
- The loader owns the visitor id as a first-party cookie on the host site and passes it to the frame over `postMessage`, with a strict origin check on both sides. The frame never relies on its own storage for identity.
- A Messenger settings page per project: allowed origins, accent colour, launcher position, greeting, team avatars (chosen from the project's support agents), and the embed snippet ready to copy.
- The frame takes its name and logo from the project brand (`brandName`, `brandLogoUrl`) and its language from the project's `language`.

## Acceptance criteria

- [ ] Pasting the snippet into a page on an allowed origin shows the launcher. Opening it shows the branded messenger.
- [ ] The host page's CSS does not affect the messenger.
- [ ] Reloading the host page, or navigating within the same site, keeps the visitor's conversation, including in Safari.
- [ ] `PlunkChat('show')`, `PlunkChat('hide')` and `PlunkChat('shutdown')` work from the host page. After `shutdown` a new visitor id is issued.
- [ ] Messages from any origin other than the frame's are ignored by the loader, and vice versa.
- [ ] Changing the colour, greeting or position in settings is reflected on the next boot.
- [ ] The loader is under 5 KB gzipped.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

1, 11, 30, 32, 40
