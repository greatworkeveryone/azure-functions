-- Migration 019: Email AI parse fields
--
-- Adds AI-classification tracking to the Emails table. The batch parser
-- (parseEmailsTimer) claims unparsed rows, hands the body + attachments
-- to codename-toddler, and writes the result back here.
--
--   AIParsedAt         — set once a parse attempt has completed (success OR failure).
--                        Null means the row is still in the queue.
--   AIClassification   — 'job' | 'quote' | 'invoice' | 'unknown'
--   AIConfidence       — 'low' | 'medium' | 'high'  (null on error)
--   AIParsedData       — JSON of extracted fields only (no body copy).
--                        Shape varies by classification.
--   AIRawResponse      — raw LLM response, retained for the Flagged Incoming
--                        dev view. Useful for prompt tuning, not for prod UX.
--   AIModelVersion     — e.g. 'llama3:8b@toddler-v1'. Lets future work identify
--                        which rows were parsed with which prompt/model.
--   AIParseError       — populated when the parse attempt threw or returned
--                        malformed output.
--   AIHintPO           — regex-extracted PO# (from subject/body/attachment text).
--                        Passed into the prompt as a soft hint.
--   AIHintQuote        — regex-extracted Quote#  (same contract).
--   AIParseAttempts    — retry counter. The batch worker stops trying after 3.
--   AIFlaggedForReview — explicit dev-review flag. Set when confidence='low'
--                        OR the parse errored. Admins view these on the
--                        Flagged Incoming page; normal users never see them.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIParsedAt')
  ALTER TABLE dbo.Emails ADD AIParsedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIClassification')
  ALTER TABLE dbo.Emails ADD AIClassification NVARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIConfidence')
  ALTER TABLE dbo.Emails ADD AIConfidence NVARCHAR(10) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIParsedData')
  ALTER TABLE dbo.Emails ADD AIParsedData NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIRawResponse')
  ALTER TABLE dbo.Emails ADD AIRawResponse NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIModelVersion')
  ALTER TABLE dbo.Emails ADD AIModelVersion NVARCHAR(50) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIParseError')
  ALTER TABLE dbo.Emails ADD AIParseError NVARCHAR(500) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIHintPO')
  ALTER TABLE dbo.Emails ADD AIHintPO NVARCHAR(50) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIHintQuote')
  ALTER TABLE dbo.Emails ADD AIHintQuote NVARCHAR(50) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIParseAttempts')
  ALTER TABLE dbo.Emails ADD AIParseAttempts INT NOT NULL
    CONSTRAINT DF_Emails_AIParseAttempts DEFAULT 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIFlaggedForReview')
  ALTER TABLE dbo.Emails ADD AIFlaggedForReview BIT NOT NULL
    CONSTRAINT DF_Emails_AIFlaggedForReview DEFAULT 0;
GO

-- Queue index: the batch picker finds unparsed rows whose attempt counter
-- hasn't burned out. Filtered index keeps the footprint small because once
-- a row is parsed it never re-enters the queue.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_AIParse_Queue' AND object_id = OBJECT_ID('dbo.Emails'))
  CREATE INDEX IX_Emails_AIParse_Queue ON dbo.Emails(AIParseAttempts, CreatedAt)
    WHERE AIParsedAt IS NULL;
GO

-- Flagged Incoming index: admins paginate these by recency.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_AIFlaggedForReview' AND object_id = OBJECT_ID('dbo.Emails'))
  CREATE INDEX IX_Emails_AIFlaggedForReview ON dbo.Emails(AIFlaggedForReview, CreatedAt)
    WHERE AIFlaggedForReview = 1;
GO
