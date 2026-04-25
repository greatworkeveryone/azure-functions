-- Migration 027: Attachment Comment
--
-- Adds a free-text Comment column to Attachments so facilities staff can
-- annotate uploaded files (e.g. "contractor invoice - March").
--
-- Fully idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Attachments') AND name = 'Comment'
)
  ALTER TABLE dbo.Attachments ADD Comment NVARCHAR(1000) NULL;
GO
