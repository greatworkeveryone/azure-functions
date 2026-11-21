-- Who an emailed quote or invoice was said to come from, and whether that was checked (SECS-02, AF4).
-- Additive and idempotent: four nullable columns on each of dbo.Quotes and dbo.JobInvoices.
-- All stay NULL for a record that was typed in rather than promoted from an email.
--   SenderCheck        'verified' (authenticated, and the address is the contractor's on record),
--                      'unverified' (the sender was not authenticated),
--                      'mismatch' (authenticated, but not the contractor's address on record)
--   SenderAddress      the From address of the source email
--   SenderConfirmedBy  the person who promoted it anyway, set only when SenderCheck is not 'verified'
--   SenderConfirmedAt  and when
IF COL_LENGTH(N'dbo.Quotes', N'SenderCheck') IS NULL
  ALTER TABLE dbo.Quotes ADD SenderCheck NVARCHAR(20) NULL;
GO
IF COL_LENGTH(N'dbo.Quotes', N'SenderAddress') IS NULL
  ALTER TABLE dbo.Quotes ADD SenderAddress NVARCHAR(320) NULL;
GO
IF COL_LENGTH(N'dbo.Quotes', N'SenderConfirmedBy') IS NULL
  ALTER TABLE dbo.Quotes ADD SenderConfirmedBy NVARCHAR(255) NULL;
GO
IF COL_LENGTH(N'dbo.Quotes', N'SenderConfirmedAt') IS NULL
  ALTER TABLE dbo.Quotes ADD SenderConfirmedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.JobInvoices', N'SenderCheck') IS NULL
  ALTER TABLE dbo.JobInvoices ADD SenderCheck NVARCHAR(20) NULL;
GO
IF COL_LENGTH(N'dbo.JobInvoices', N'SenderAddress') IS NULL
  ALTER TABLE dbo.JobInvoices ADD SenderAddress NVARCHAR(320) NULL;
GO
IF COL_LENGTH(N'dbo.JobInvoices', N'SenderConfirmedBy') IS NULL
  ALTER TABLE dbo.JobInvoices ADD SenderConfirmedBy NVARCHAR(255) NULL;
GO
IF COL_LENGTH(N'dbo.JobInvoices', N'SenderConfirmedAt') IS NULL
  ALTER TABLE dbo.JobInvoices ADD SenderConfirmedAt DATETIME2 NULL;
GO
