# Issue: Performance-test fragility under host contention

Status: corrected — original diagnosis was wrong
Date: 2026-08-27 (rewritten 2026-08-28)

## Parent

Not from the identity PRD — found while verifying `docs/issues/00-extract-mailable-contact-predicate.md`.

## Correction

The original version of this issue claimed `test/performance/pagination.perf.test.ts` fails on a
clean `next`, and blamed the file's `beforeEach` for seeding 10,000 contacts against a 30s
`hookTimeout`. **Both claims are wrong**, and the fix they implied would have been a change to
accommodate a problem that isn't there.

Measured on 2026-08-28 with no competing processes on the host:

- The file's `beforeEach` creates a project and nothing else. It is fast. The 10,000-contact seeds
  live inside individual tests, which declare their own 60s/90s/120s timeouts.
- `npx vitest run test/performance/pagination.perf.test.ts` → 15/15 passed.
- `npx vitest run test/performance/` → 37/37 passed, 4 files.
- `npx vitest run --project=plunk` (the full CI suite, performance tests included) → **1361/1361
  passed, 52 files**.

## The actual mechanism

The failures were real but externally caused: multiple `vitest` processes running concurrently on
the same host, against the same Postgres container. Vitest uses `pool: 'forks'` with `maxWorkers: 4`
and per-worker databases (`plunk_test_w1..w4`), which isolates *data* but not the *machine* — CPU
and the single Postgres instance are shared. A second suite started alongside the first roughly
doubles the load, and timing-sensitive work (10k-row seeds, throughput assertions, token-bucket
refill windows) starts missing its budget.

This repeatedly presented as an application bug: FK violations on `events_projectId_fkey`, or
`expected +0 to be 10000`. The tell is that the failure count varies run to run with no code
change, and that every failing test passes when its file is run alone.

`apps/api/src/middleware/__tests__/rateLimit.test.ts` ("never refills past the burst ceiling while
idle") is load-sensitive by construction for the same reason: `refillPerSecond: 100`, `burst: 2`,
a 100ms sleep, then three sequential Redis round-trips expected to consume exactly two tokens. On a
loaded machine the calls accrue a third.

## What is actually worth doing

Not a fixture rewrite. The suite is deterministic when it has the machine to itself, which is the
condition CI runs under.

- [ ] Document the constraint where it will be read — one line in the testing section of
      `CLAUDE.md`: never run two vitest invocations concurrently on this repo; timing-sensitive
      tests will produce false failures.
- [ ] Consider making the `rateLimit` idle-refill test tolerant of an extra accrued token, since
      it asserts a ceiling rather than an exact count. Weakening it is acceptable only if the
      ceiling property it exists to protect is still asserted.
- [ ] `test/performance/template-rendering.perf.test.ts` throughput assertions carry the same
      machine-dependence. Review and either make robust or document as environment-sensitive.

## Blocked by

None
