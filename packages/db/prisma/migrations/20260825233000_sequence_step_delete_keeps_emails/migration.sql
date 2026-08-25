-- Deleting a sequence step is a routine edit and must not take already-sent mail
-- with it: those Email rows are the billing and contact-activity record. Stats
-- aggregate on "sequenceId", which is left alone, so they stay correct once the
-- step attribution is cleared.
ALTER TABLE "emails" DROP CONSTRAINT "emails_sequenceStepId_fkey";

ALTER TABLE "emails" ADD CONSTRAINT "emails_sequenceStepId_fkey" FOREIGN KEY ("sequenceStepId") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
