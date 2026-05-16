-- 050_quote_director_approval.sql
--
-- Adds stage-2 ("Director") approval audit + email-send audit to dbo.Quotes.
-- The Status column gains new values 'awaiting_director' and 'approved'
-- (re-used 'approved' label for the FINAL state — symmetric with current
-- usage); column is unconstrained NVARCHAR, no schema change for the
-- status values themselves.
--
-- Status flow:
--   pending → approved                (no director needed)
--   pending → awaiting_director       (director needed; email sent)
--                  → approved          (director signs off — Jobs.ApprovedQuoteID is set HERE)
--   any → rejected
--
-- Re-runnable.

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'DirectorApprovedAt')
  ALTER TABLE dbo.Quotes ADD DirectorApprovedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'DirectorApprovedBy')
  ALTER TABLE dbo.Quotes ADD DirectorApprovedBy NVARCHAR(200) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'DirectorEmailSentAt')
  ALTER TABLE dbo.Quotes ADD DirectorEmailSentAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'DirectorEmailSentTo')
  ALTER TABLE dbo.Quotes ADD DirectorEmailSentTo NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'DirectorEmailSentBy')
  ALTER TABLE dbo.Quotes ADD DirectorEmailSentBy NVARCHAR(200) NULL;
GO
