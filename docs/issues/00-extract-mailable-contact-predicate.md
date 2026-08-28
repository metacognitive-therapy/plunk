# Issue: Extract the mailable-contact predicate

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

A pure prefactor with no behaviour change. See `docs/issues/TECH-STRATEGY.md` — this issue was
revised after measuring the code, and the strategy document is authoritative.

The condition deciding whether a contact may be sent marketing email is written independently at
four send sites, and they are **not four instances of one shape**:

- Campaign audience selection uses a Prisma where-fragment, skipped entirely for transactional campaigns.
- Sequence enrolment and send uses a nested relation filter.
- The transactional-API marketing-template guard fetches the contact and **throws** a 400.
- The workflow send guard fetches the contact and **silently skips**, returning an unsent placeholder row.

Two are query clauses; two are procedural guards with deliberately different failure modes. One
where-fragment cannot serve all four.

Export two things from a single new module, both derived from one shared constant so they cannot drift:

- a `Prisma.ContactWhereInput` fragment for the two query sites — the sequence site nests it under its contact relation;
- a boolean predicate over a fetched contact for the two imperative sites, which keep their own throw and skip behaviour and delegate only the *decision*.

Place it in `apps/api/src/database/`, alongside the Prisma client the services already import. There
is no existing shared query-helper layer; this is new surface, and it must not live in a service,
because services will import it.

The `select` at both imperative sites widens to cover whatever fields the predicate reads.

Today the predicate means exactly `subscribed === true` and nothing more, so every compiled query
and every guard outcome must be identical to current behaviour. This exists because every later
slice widens that predicate; without one definition, each widening is four edits in four shapes and
the guard drifts — the exact failure the chokepoints exist to prevent.

## Acceptance criteria

- [ ] One module exports both a where-fragment and a boolean predicate, derived from a single shared definition.
- [ ] It lives in `apps/api/src/database/`, not in a service and not in `utils/`.
- [ ] Campaign audience selection and sequence enrolment consume the where-fragment.
- [ ] Both email-send guards consume the boolean predicate and retain their existing failure modes — one throws a 400, the other silently returns an unsent placeholder.
- [ ] Transactional sends remain exempt from the subscription condition exactly as they are today.
- [ ] The marketing-template guard still applies only to marketing templates; the workflow guard still exempts custom recipient addresses.
- [ ] The full existing test suite passes with **no test modified**. A test needing a change means behaviour moved, which this slice forbids.
- [ ] No schema change, no API change, no UI change.

## Blocked by

None - can start immediately
