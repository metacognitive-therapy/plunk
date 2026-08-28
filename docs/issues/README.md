# Issues

Vertical slices ready for independent pickup. Each is a complete path through every layer — schema, API, guards, surface, tests — and is demoable on its own.

`docs/prds/` holds the specifications; this directory holds the work items derived from them. GitHub issues are disabled on this repository, so a file here is an issue, and `Status: ready-for-agent` in its header is the triage label.

## Contact Identity and Leads

Source: `docs/prds/contact-identity-and-leads.md`

| # | Issue | Blocked by | PRD user stories |
|---|---|---|---|
| 00 | Extract the mailable-contact predicate | — | enabler for 01 |
| 01 | Leads — a contact can exist without an email address | 00 | 4, 7, 8, 9, 10, 12, 43 |
| 02 | Identify resolution and binding | 01 | 1, 2, 3, 5, 6, 11, 21, 22, 24, 39, 40, 41, 42 |
| 03 | Track by external id | 02 | 13, 16, 17, 23, 45 |
| 04 | Event occurrence time | — | 18, 19, 20 |
| 05 | Project sending pause | — | 25, 26, 27, 28 |
| 06 | Trigger-name cache for high-volume events | — | 36, 37, 38 |
| 07 | Anonymize replaces hard delete | 01 | 29, 30, 31, 32, 33, 34, 35 |
| 08 | Contact identities | 01 | 14, 15 |

## Test infrastructure

| # | Issue | Blocked by | Notes |
|---|---|---|---|
| 09 | Fix the performance-test fixtures | — | Pre-existing failure on `next`, unrelated to the PRD. CI runs perf tests, so the safety net is currently red. |

Story 44 (wiki documentation) is distributed across the slices that change behaviour, rather than deferred to a slice of its own.

04, 05, and 06 are independent of the identity chain and of each other. 06 is a prerequisite for sending behavioural events at product volume, so it should not be left until last despite having no blocker.
