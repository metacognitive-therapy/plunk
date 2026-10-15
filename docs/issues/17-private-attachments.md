# Issue: Private attachments

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

Image and file attachments, up to 10 MB, in both directions.

- Stored in a separate private bucket (new environment variable), never under `S3_PUBLIC_URL`.
- Uploads are type-allowlisted and size-checked server-side.
- Downloads are short-lived presigned URLs (about five minutes), issued only to the conversation's messenger session or to a support agent of the project.
- Images render inline in both the messenger and the Inbox. Other files render as a download chip.
- The new environment variable is added to `apps/api/.env.example`, `.env.self-host.example` and the wiki's environment-variables page.

## Acceptance criteria

- [ ] A visitor and an agent can each attach an image and a PDF. Both sides see them.
- [ ] The object is not readable without a presigned URL, and a presigned URL stops working after it expires.
- [ ] A session from another conversation, or a non-agent member, cannot obtain a URL.
- [ ] Oversized and disallowed files are refused before they are stored.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

9
