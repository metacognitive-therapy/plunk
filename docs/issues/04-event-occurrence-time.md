# Issue: Event occurrence time

Status: ready-for-agent
Date: 2026-08-27

## Parent

`docs/prds/contact-identity-and-leads.md`

## What to build

Separate *when an event happened* from *when Plunk received it*. Today only ingestion time exists, so a segment for "finished a module in the last 7 days" is wrong whenever delivery lags — a retried or queued event lands in the wrong window and the audience is silently incorrect.

Events gain an occurrence timestamp, defaulting to now so existing callers are unaffected, and settable by the caller on the track endpoint.

Only the **recency predicates** switch to it: the segment conditions for "triggered since" and "triggered older than", and the equivalent campaign-audience filters. Everything genuinely about ingestion stays on the existing created-at: the contact event feed, the project event feed, and event statistics over a date range. Those answer "what did Plunk receive, and when", and are the instrument for diagnosing delivery lag — moving them would destroy the diagnostic the new field exists to make possible.

The composite index serving event-based segment queries is *extended* rather than repointed, so the feed's ordering stays indexed. Whether created-at can then be dropped from it is a question for query plans at real volume, not a decision to make in advance — but index count on the highest-volume table must not grow unbounded, so if the plans show the extended index serves both, consolidate.

## Acceptance criteria

- [ ] Events carry an occurrence timestamp, defaulting to the current time when the caller does not supply one.
- [ ] The track endpoint accepts an explicit occurrence time and validates it.
- [ ] Segment recency conditions — both "triggered since" and "triggered older than" — evaluate against occurrence time.
- [ ] Campaign-audience event filters evaluate against occurrence time.
- [ ] The contact event feed, project event feed, and event statistics continue to use ingestion time.
- [ ] An event ingested late but with an earlier occurrence time falls into the window its occurrence time implies, not the one its arrival implies.
- [ ] The composite index supporting event-based segment queries covers occurrence time, and query plans for both the segment queries and the feed are checked at representative volume before the index set is finalised.
- [ ] API reference documents the field and the distinction between the two timestamps.

## Blocked by

None - can start immediately
