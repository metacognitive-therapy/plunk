# Technical strategy: Contact Identity and Leads

Status: reference
Date: 2026-08-27

Binding constraints for every issue in this batch. Read before starting any slice. Where this
document and an issue disagree, this document wins — the issues were written from the PRD, this
was written from the code.

## Findings that changed the plan

**1. There is no shared query-helper layer.** `apps/api/src` has `app/`, `controllers/`,
`database/`, `exceptions/`, `jobs/`, `middleware/`, `services/`, `utils/`. Services import
`prisma` from `../database/prisma.js` directly and compose `Prisma.ContactWhereInput` inline.
The mailable predicate is new shared surface: put it in `apps/api/src/database/contact-filters.ts`,
exporting `Prisma.ContactWhereInput` fragments. Not `utils/` (generic helpers), not a service
(services import it, and a service-to-service import for a where-fragment inverts the layering).

**2. The four chokepoints are NOT four instances of one predicate.** This is the correction to
issue 00, which described them as duplicates of the same condition. Measured:

| Site | Shape | Condition |
|---|---|---|
| `CampaignService.ts:1114` | where-fragment | `subscribed: true`, skipped for TRANSACTIONAL campaigns |
| `SequenceService.ts:419` | nested relation filter | `contact: {subscribed: true}` |
| `EmailService.ts:66` | imperative fetch-then-throw | throws 400 if not subscribed, only for MARKETING templates |
| `EmailService.ts:212` | imperative fetch-then-skip | silently returns an unsent placeholder row |

Two are Prisma where-clauses; two are procedural guards with different failure modes (one throws,
one silently succeeds). A single where-fragment cannot serve all four. Issue 00 as written would
either fail or force the two imperative guards into an unnatural shape.

**Revised issue 00:** export *two* things from one module —
- `mailableContactWhere(): Prisma.ContactWhereInput` — consumed by the two query sites. Sequence
  nests it under `contact:`.
- `isMailableContact(contact): boolean` — consumed by the two imperative sites, which keep their
  own throw/skip behaviour and only delegate the *decision*.

Both derive from one exported constant so they cannot drift. The `select` at both imperative sites
widens to cover the fields the predicate reads. Still a pure prefactor: today both mean exactly
`subscribed === true`, and no test may change.

**3. Nullable email cannot be a schema-only change.** `Contact.email` is `String` and
`@@unique([projectId, email])`. Prisma types the compound-unique input as
`{projectId: string, email: string}`, so making the column nullable **removes
`projectId_email` from the generated `ContactWhereUniqueInput`**. Grep confirms zero call sites use
it today — every lookup is already `findFirst({where: {projectId, email}})`, including
`ContactService.upsert`, which is hand-rolled rather than using `prisma.contact.upsert`. There is
also no `prisma.contact.upsert` call anywhere in the repo.

So the migration is unusually safe, but this is *why* it is safe, and it must be re-verified rather
than assumed: before touching the schema, re-run `grep -rn "projectId_email" apps/ packages/`
excluding `node_modules` and migrations. A non-empty result means this analysis is stale and the
call sites must be converted to `findFirst` first, in a separate commit.

**4. Postgres nulls are distinct in a unique index, but that is not the whole story.** Many
leads coexist under `@@unique([projectId, email])`. But `upsert`'s find-then-create is not atomic,
so two concurrent identifies for the same new email can both miss and both create. That race
exists today and is masked by the non-null constraint plus the unique index rejecting the second
insert. With nullable email and a new `externalId` unique constraint, the same race appears on a
second key. Issue 02 must handle unique-violation (P2002) on both `(projectId, email)` and
`(projectId, externalId)` by re-reading and retrying once, rather than surfacing a 500.

**5. The shared predicate must become a per-field spec before slice 01 widens it.** Found during
slice 00 implementation. The boolean export currently decides by scalar equality against the shared
constant (`contact.subscribed === CONDITION.subscribed`). That only works while every field in the
condition is a scalar equality. Slice 01 adds `email != null`, which the where-fragment expresses as
`{not: null}` and the boolean must express as `contact.email != null` — different shapes for the
same rule. A naive widening therefore makes the two exports silently disagree, which is precisely
the drift the shared constant exists to prevent.

Restructure before widening: the shared definition becomes a list of named conditions, each
supplying both its Prisma fragment and its boolean check, with the two exports composing over that
list. Slice 01 must do this restructuring *first*, as its own step, and only then add the new
fields. Do not widen the existing scalar-equality shape.

## Sequencing

Ship in this order. 00 → 01 → 02 → 03 is a hard chain; 04, 05, 06 are independent.

Start 06 early despite it having no blocker. It is a prerequisite for the event volume this whole
PRD exists to enable, not a tuning pass.

## Non-negotiables

- **Never widen the mailable predicate at one site only.** Once slice 01 adds `email != null` and
  `deletedAt == null`, all four sites take it from the shared module in the same commit.
- **Transactional sends stay exempt from `subscribed`** — but are NOT exempt from `email != null`.
  You cannot send to an address that does not exist. Model these as two separate conditions, not
  one flag: a null-email contact is unmailable by *every* path including transactional; an
  unsubscribed contact is unmailable by marketing paths only.
- **No `role`, `type`, or `isLead` column.** Lead-ness is derived. A stored discriminator will
  drift from the columns it summarises.
- **Identify is the only writer of persistent contact attributes.** Track does not merge event data
  onto the contact.
- **`ContactService.upsert` keeps its current behaviour on the email path.** Slice 02 adds
  resolution-by-external-id around it; it does not rewrite the email path's semantics. Existing
  callers and their tests are the contract.
- **Preserve `normalizeEmail` on every path that accepts an email**, identify included. Case-variant
  addresses are one person, and skipping normalisation on the new path silently creates duplicates
  the unique index will not catch.
- **Do not use `prisma.contact.upsert`.** The hand-rolled find-then-update exists because it emits
  `contact.subscribed` / `contact.unsubscribed` events on transition, which a native upsert cannot.

## Testing

Real isolated Postgres per worker via the existing setup; no Prisma mocking. Assert externally
observable behaviour — API response, resulting DB state, whether an email row was created and
whether it was sent — never call counts or private methods.

Seams, highest first: the existing `apps/api/src/__tests__/integration/` suite (`actions.test.ts`
is the home for the `/v1/identify` and external-id track contract — it already covers
request-schema-plus-service-layer for `/v1/track`, which is the house convention: no live HTTP
server); then `ContactService` and `EventService` service tests; then the four chokepoint test
files; then `email-processor` for the pause; then `test/performance/` for the flat-cost assertion.

The chokepoint invariant is stated once per site, four times: a null-email contact and a
`deletedAt` contact are never selected, never enrolled, never sent — while an equivalent reachable
contact is.

## Handoff

Slices are implemented by Sonnet 5 against this document. Deviation from anything under
**Non-negotiables** requires escalation rather than a judgement call — each one encodes a
constraint found in the code whose rationale is not visible from the diff.

## Finding 6 — Slice 08's `type` must be a string column, not a Prisma enum

The acceptance criterion "extensible to push tokens **without a schema migration**" rules out a
Prisma enum: adding an enum value is an `ALTER TYPE`, i.e. a migration. So `type` is a `String`
column, and the vocabulary lives in application code (a shared const + Zod enum) where adding
`push_token` is a one-line change with no DDL.

The unique constraint is `(projectId, type, value)`, which forces `projectId` onto the identity
row as a denormalized column — the contact relation alone cannot express it.

### The integration point that is easy to miss

Anonymization has **two** implementations, and both must drop identities inside their existing
transaction:

- `ContactService.anonymizeContact` (single)
- `ContactService.bulkDelete` (bulk — a separate `updateMany` path, not a loop over the single one)

An anonymized contact holding a live `anonymous_id` is exactly the leak this slice's criterion
forbids. A test that only covers the single path passes while the bulk path leaks.

### Re-pointing, not merging

`recordIdentity` upserts on `(projectId, type, value)`: an existing row is re-pointed to the given
contact and its `lastSeenAt` refreshed. That is the normal case, not an anomaly — an anonymous id
first seen on a lead legitimately moves to the contact it later resolves to. It re-points the
identity only; **merging the two contacts is out of scope** for this PRD. Upserting also means the
unique constraint never throws P2002 in normal operation.

### Scope fence

Nothing consumes this table in this slice. Do not wire it into `identify`, `/v1/track`, or any
ingestion path — web-guest ingestion and the push channel are both out of scope. Email and
externalId stay as columns on `Contact` and are not migrated in.
