-- Migration 133: who archived an email, and when (S3, SEC-05).
--
-- archiveEmail hides an email from Incoming. It now stamps the person (display
-- name, as Jobs.ArchivedBy and Assets.ArchivedBy do) and the time, in the same
-- transaction as its email.archive ledger row. Rows archived before this
-- migration keep NULL: their record is the ledger, or nothing.
--
-- Additive and re-runnable: each column is NULLable and behind an existence
-- check; no existing row is touched. One batch per column, because a batch is
-- compiled before it runs.

IF COL_LENGTH('dbo.Emails', 'ArchivedBy') IS NULL
  ALTER TABLE dbo.Emails ADD ArchivedBy NVARCHAR(256) NULL;
GO

IF COL_LENGTH('dbo.Emails', 'ArchivedAt') IS NULL
  ALTER TABLE dbo.Emails ADD ArchivedAt DATETIME2 NULL;
GO
