-- Migration 114: link each payment to the incoming invoice it pays.
--
-- upsertPayment now requires an approved incoming invoice, so Payments gets
-- a JobInvoiceID. Existing rows keep NULL (they predate the link); only new
-- payments carry it.
--
-- Additive and re-runnable: every statement is behind an existence check, the
-- new column is NULLable, and no existing row is touched. The column, foreign
-- key and index each get their own batch because a batch is compiled before it
-- runs, so a statement can't reference a column the same batch creates.

IF COL_LENGTH('dbo.Payments', 'JobInvoiceID') IS NULL
  ALTER TABLE dbo.Payments ADD JobInvoiceID INT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
   WHERE name = 'FK_Payments_JobInvoices'
     AND parent_object_id = OBJECT_ID('dbo.Payments')
)
  ALTER TABLE dbo.Payments ADD CONSTRAINT FK_Payments_JobInvoices
    FOREIGN KEY (JobInvoiceID) REFERENCES dbo.JobInvoices(JobInvoiceID);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_Payments_JobInvoiceID'
     AND object_id = OBJECT_ID('dbo.Payments')
)
  CREATE INDEX IX_Payments_JobInvoiceID ON dbo.Payments(JobInvoiceID);
GO
