-- 044_jobinvoices_myob_created.sql
--
-- Adds MYOB tracking columns to dbo.JobInvoices, mirroring the pair already
-- on dbo.PurchaseOrders (m025):
--
--   MyobCreatedAt DATETIME2  — UTC timestamp when the invoice was recorded
--                              in MYOB (null until marked).
--   MyobCreatedBy NVARCHAR   — caller name from the JWT, mirrors CreatedBy.
--
-- Used by outgoing (oncharge) invoices today — the /markJobInvoiceMyobCreated
-- and /unmarkJobInvoiceMyobCreated handlers flip these fields. Incoming
-- contractor invoices may use them later if/when the direct MYOB integration
-- lands; the schema doesn't gate on Direction.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'MyobCreatedAt'
)
  ALTER TABLE dbo.JobInvoices ADD MyobCreatedAt DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'MyobCreatedBy'
)
  ALTER TABLE dbo.JobInvoices ADD MyobCreatedBy NVARCHAR(200) NULL;
GO
