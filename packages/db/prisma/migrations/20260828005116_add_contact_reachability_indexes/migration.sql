-- Partial indexes supporting the reachability predicates in
-- apps/api/src/database/contact-filters.ts. Prisma's schema DSL has no filtered-index syntax,
-- so these are hand-written raw SQL rather than `@@index` in schema.prisma.

-- Email-reachable / mailable contacts: email present, subscribed, not deleted. Backs the four
-- send chokepoints (campaign audience selection, sequence enrolment/send, and both
-- transactional/workflow send guards) and the dashboard's mailable headline count.
CREATE INDEX "contacts_mailable_idx" ON "contacts" ("projectId") WHERE "email" IS NOT NULL AND "subscribed" = true AND "deletedAt" IS NULL;

-- Leads: contacts with no email. Backs the dashboard's lead count/listing and lead-vs-mailable
-- reporting.
CREATE INDEX "contacts_leads_idx" ON "contacts" ("projectId") WHERE "email" IS NULL;
