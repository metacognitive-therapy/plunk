# Issue: Abuse protection for the messenger

Status: ready-for-agent
Date: 2026-10-15

## Parent

`docs/prds/live-chat.md`

## What to build

- Redis rate limits, per visitor and per IP, on boot, new conversations, messages, uploads and email capture. Limits come back as a distinguishable 429 that the messenger renders as a friendly message.
- Invisible Cloudflare Turnstile on conversation start. The site key is served to the frame, and the token is verified server-side with the secret key (new environment variables, added to all three env files). When Turnstile is not configured the check is skipped, with a startup warning, so self-hosters without Cloudflare still work.

## Acceptance criteria

- [ ] Exceeding each limit returns 429, and the visitor can continue after the window.
- [ ] Starting a conversation without a valid Turnstile token is refused when Turnstile is configured.
- [ ] Existing conversations keep working without a new Turnstile token.
- [ ] With Turnstile unconfigured, conversations can still start and a warning is logged once.

## Blocked by

- `docs/issues/10-conversation-core.md`

## User stories

37
