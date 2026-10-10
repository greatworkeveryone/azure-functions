-- Migration 089: JobEvents.SourceEmailID
--
-- Links a timeline event to the inbound email it was promoted from, so the
-- job timeline can offer "view email". Written by promoteEmailToJobUpdate
-- (EventType 'email_update') and by director decisions recorded from a reply
-- (recordEmailQuoteDecision → src/quote-decisions.ts). Like
-- Jobs.SourceEmailID / Quotes.SourceEmailID, but with a real FK
-- (ON DELETE SET NULL).
--
-- ON DELETE SET NULL: the event is the record, the email is provenance.
-- No index — the column is written on promote and read only when a timeline
-- row is opened; nothing queries JobEvents by email.
--
-- Idempotent: both steps are guarded.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'SourceEmailID')
  ALTER TABLE dbo.JobEvents ADD SourceEmailID INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_JobEvents_SourceEmail' AND parent_object_id = OBJECT_ID('dbo.JobEvents'))
  ALTER TABLE dbo.JobEvents
    ADD CONSTRAINT FK_JobEvents_SourceEmail
    FOREIGN KEY (SourceEmailID) REFERENCES dbo.Emails(EmailID) ON DELETE SET NULL;
GO
