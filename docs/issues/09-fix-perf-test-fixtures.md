# Issue: Fix the performance-test fixtures

Status: ready-for-agent
Date: 2026-08-27

## Parent

Not from the identity PRD — found while verifying `docs/issues/00-extract-mailable-contact-predicate.md`.

## What to build

`test/performance/pagination.perf.test.ts` fails on a clean `next`, independently of any feature
work, and CI runs `yarn test:run` with the performance tests included — so the branch's safety net
is already red. That matters beyond tidiness: a suite that fails for its own reasons cannot tell
anyone that a real regression has landed.

The mechanism, diagnosed rather than guessed:

- Vitest is configured with `hookTimeout: 30000`.
- The file's `beforeEach` seeds 10,000 contacts. On a contended or slow machine that alone exceeds 30s.
- Several tests in the file declare 60s, 90s, and 120s timeouts precisely because this work is slow —
  but the *hook* budget is separate and stays at 30s.
- When the hook times out, the global `afterEach` in the test setup still runs and issues
  `TRUNCATE ... RESTART IDENTITY CASCADE`, deleting the project row the test is still using.
- The test then fails with a foreign-key violation on `events_projectId_fkey`, or an assertion like
  `expected +0 to be 10000` — symptoms that look like application bugs and are not.

Evidence: each failing test passes when run alone with `-t`, and fails when run alongside its
siblings. Failure count varies run to run (7, then 10, then 7) with no code change, which is the
signature of a timing-dependent fixture rather than a broken assertion.

Fix the fixture so the suite is deterministic. The direct cause is the hook budget being smaller
than the work the hook does, so raising `hookTimeout` for this project is the minimum change — but
seeding 10,000 rows before *every* test in the file is the underlying waste, and moving that to a
one-time setup shared across the file would remove the pressure rather than accommodate it. Prefer
the latter if the tests can share a seeded project without cross-contaminating.

Whatever the approach, the truncating `afterEach` must not be able to run while a test still holds
references to the rows it deletes.

## Acceptance criteria

- [ ] `npx vitest run test/performance/pagination.perf.test.ts` passes reliably, repeated at least three times.
- [ ] The full `npx vitest run --project=plunk` passes with no failures in `test/performance/`.
- [ ] No test's assertions are weakened or its thresholds relaxed to achieve this — the fixture is fixed, not the expectation.
- [ ] The memory assertions still measure retained memory, keeping the forced-collection behaviour the config comments describe.
- [ ] `test/performance/template-rendering.perf.test.ts` throughput assertions are reviewed for the same class of machine-dependence, and either made robust or documented as environment-sensitive.

## Blocked by

None - can start immediately
