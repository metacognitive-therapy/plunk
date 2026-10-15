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

## Live Chat

Source: `docs/prds/live-chat.md`

| # | Issue | Blocked by | PRD user stories |
|---|---|---|---|
| 10 | Conversation core | none | 2, 13, 29, 32 |
| 11 | Embeddable messenger and appearance | 10 | 1, 11, 30, 32, 40 |
| 12 | Realtime delivery, typing and read receipts | 10 | 6, 13, 27 |
| 13 | Email capture and consent | 10 | 4, 5, 12 |
| 14 | Inbox workflow (states, snooze, assignment) | 10 | 19, 20, 21, 22 |
| 15 | Internal notes and mentions | 10 | 23 |
| 16 | Saved replies and conversation tags | 10 | 24, 25 |
| 17 | Private attachments | 10 | 9 |
| 18 | Reply by email | 13 | 7, 8, 28, 33 |
| 19 | In-app notifications, Web Push and the installable dashboard | 12 | 14, 15, 18 |
| 20 | Email fallback and Slack notifications | 14 | 16, 17, 34 |
| 21 | Abuse protection for the messenger | 10 | 37 |
| 22 | Office hours, reply time and visitor history | 11 | 3, 10, 31 |
| 23 | Chat events and the contact page | 13, 14 | 26, 38, 39 |
| 24 | Conversation retention and erasure | 17 | 35, 36 |
| 25 | Identified mode (signed user tokens) | 13 | 41, 44 |
| 26 | React Native messenger SDK | 12, 25 | 42, 45 |
| 27 | Push notifications for mobile messenger replies | 26 | 43 |
| 28 | SDK identify and track (Intercom analytics replacement) | 26 | 46 |
| 29 | Intercom import | 14, 25 | 47 |

10 through 24 are Phase 1 (websites), 25 through 28 are Phase 2 (noworries.app), and 29 is Phase 3. The identity prerequisites for Phase 2 (issues 02, 03 and 06) have already landed.

## Test infrastructure

| # | Issue | Blocked by | Notes |
|---|---|---|---|
| 09 | Fix the performance-test fixtures | — | Pre-existing failure on `next`, unrelated to the PRD. CI runs perf tests, so the safety net is currently red. |

Story 44 (wiki documentation) is distributed across the slices that change behaviour, rather than deferred to a slice of its own.

04, 05, and 06 are independent of the identity chain and of each other. 06 is a prerequisite for sending behavioural events at product volume, so it should not be left until last despite having no blocker.
