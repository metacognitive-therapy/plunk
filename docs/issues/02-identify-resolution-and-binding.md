# Issue: Identify resolution and binding

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

Complete `POST /v1/identify` into the authoritative entry point for contact identity. This is the slice that fixes a live defect: today, a contact who changes their email address silently becomes a *second* contact, abandoning their tags, sequence position, and history on the old row while the new one starts from nothing.

Resolution order is external id first, then email. Four cases, each with distinct behaviour:

- **Neither found** — create the contact. Subscription state comes from the request; absent that, the existing default applies.
- **Found by external id** — update, *including adopting a changed email onto the same row*. This is the fix.
- **Found by email, external id is null** — bind the external id onto that existing contact. This is the primary path for every contact already in Plunk, not an edge case; there is no migration or backfill, so contacts adopt their external id lazily here.
- **Found by email, external id is a different non-null value** — refuse with a conflict. Silently moving a subscription between two identified people is never correct.

Identify is the only path permitted to write persistent contact attributes, and it writes a bounded declared set — the attribute space is GIN-indexed and drives segmentation, so it must stay finite, and every attribute must mean *current state* rather than the value carried by whichever event happened to arrive last.

A lead gaining an email emits a new reserved event, `contact.identified`, exactly once. That event is the one predictable hook for conversion messaging.

Conversion must not cause an automation flood. Applying a tag through the normal tagging path emits `tag.added`, which routes into sequence auto-enrolment — so a guest who earned five tags would, on signing up, be enrolled into every sequence bound to any of them, simultaneously. Identify-time tag and attribute movement therefore writes directly, bypassing the event-emitting path.

## Acceptance criteria

- [ ] All four resolution cases behave as described, including the conflict refusal, which returns a distinguishable error rather than merging or guessing.
- [ ] A contact found by external id adopts a changed email on the same row, retaining tags, segment membership, sequence subscriptions, step-send records, workflow executions, events, and send history.
- [ ] Binding an external id onto a contact that has none leaves everything else on that contact untouched.
- [ ] Identify is convergent: calling it repeatedly with the same payload produces the same state and does not error.
- [ ] Identify is the only path that writes persistent contact attributes, and writes only the bounded declared set.
- [ ] `contact.identified` is in the reserved event set, cannot be tracked manually, and is emitted exactly once when a lead first gains an email.
- [ ] Identify-time tag movement does not emit `tag.added` and does not trigger sequence auto-enrolment.
- [ ] A converted lead does become eligible for the sequences and campaigns its state now qualifies it for, through the normal eligibility path.
- [ ] Wiki and API reference document identify, including the conflict case.

## Blocked by

- `docs/issues/01-leads-contacts-without-email.md`
