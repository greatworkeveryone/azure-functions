-- Migration 022: EmailReplies — attachment metadata
--
-- AttachmentNames stores a JSON array of file names sent with a reply
-- (e.g. '["quote.pdf","specs.docx"]'). The actual file bytes are never
-- stored here — they travel inline to Graph API only. This column lets
-- the thread view display what was attached without re-fetching anything.
--
-- Fully idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.EmailReplies') AND name = 'AttachmentNames'
)
  ALTER TABLE dbo.EmailReplies ADD AttachmentNames NVARCHAR(MAX) NULL;
GO
