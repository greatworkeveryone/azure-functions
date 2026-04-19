-- Migration 011: AI-validation tracking on Quotes
--
-- When a quote is extracted from an inbound email (SourceEmailID set) the
-- UI tags it "AI Generated — must be validated". A human reviews the source
-- email + the parsed values and clicks "Validate", which stamps the two
-- columns below. The tag renders while AIValidatedAt is NULL.
--
-- Manual quotes (SourceEmailID IS NULL) are implicitly validated — the UI
-- never shows the tag for them, so no data change on existing rows needed.
--
-- Fully idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'AIValidatedBy'
)
  ALTER TABLE dbo.Quotes ADD AIValidatedBy NVARCHAR(200) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Quotes') AND name = 'AIValidatedAt'
)
  ALTER TABLE dbo.Quotes ADD AIValidatedAt DATETIME2 NULL;
GO
