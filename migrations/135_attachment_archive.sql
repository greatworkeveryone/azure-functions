-- 135_attachment_archive — archive stamp on files (D4, DL-19).
--
-- A tenancy's lease documents are archived, never deleted: deleteAttachment
-- refuses a file a TenancyAttachments row links (the cascade would drop the
-- link with no record kept), and archiveTenancyDocument stamps these two
-- columns and ledgers tenancy.document_archive. getTenancyAttachments leaves
-- archived documents out unless includeArchived=true.
--
-- Additive and re-runnable: two nullable columns, each behind a column-exists
-- guard. Nothing is backfilled, rewritten or deleted. (Lane N's planned
-- de-duplication column moves to 136 or later.)

IF COL_LENGTH(N'dbo.Attachments', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.Attachments ADD ArchivedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.Attachments', N'ArchivedBy') IS NULL
  ALTER TABLE dbo.Attachments ADD ArchivedBy NVARCHAR(255) NULL;
