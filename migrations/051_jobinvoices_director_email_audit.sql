-- 051_jobinvoices_director_email_audit.sql
--
-- Tracks who/when the director-approval email was sent for an invoice.
-- DirectorEmailSentTo holds a JSON array of email addresses (stored as
-- NVARCHAR(MAX) — we don't need SQL Server's JSON ops, just round-trip).
--
-- Re-runnable.

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'DirectorEmailSentAt')
  ALTER TABLE dbo.JobInvoices ADD DirectorEmailSentAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'DirectorEmailSentTo')
  ALTER TABLE dbo.JobInvoices ADD DirectorEmailSentTo NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'DirectorEmailSentBy')
  ALTER TABLE dbo.JobInvoices ADD DirectorEmailSentBy NVARCHAR(200) NULL;
GO
