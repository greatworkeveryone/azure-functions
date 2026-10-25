-- Migration 134: invoice_attachments (beta sprint J9)
--
-- dbo.JobInvoiceAttachments links attachments to job invoices, as
-- PurchaseOrderAttachments and QuoteAttachments (migration 010) do for POs and
-- quotes: a thin join row, so one file on the job can back an invoice without
-- copying the blob. The frontend's attachToInvoice / detachFromInvoice /
-- getInvoiceAttachments calls had no table or route behind them.
--
-- Additive only: one new table and its index, each behind an existence check,
-- safe to run twice. Deleting an invoice or an attachment removes only the
-- link row (ON DELETE CASCADE, as on the existing link tables); the
-- attachment and its file are untouched.
--
-- RUNBOOK: apply 134 before the build that serves attachToInvoice.

IF OBJECT_ID('dbo.JobInvoiceAttachments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.JobInvoiceAttachments (
    JobInvoiceID     INT            NOT NULL,
    AttachmentID     INT            NOT NULL,
    AttachedAt       DATETIME2      NOT NULL CONSTRAINT DF_InvAtt_AttachedAt DEFAULT SYSUTCDATETIME(),
    AttachedBy       NVARCHAR(200)  NULL,
    CONSTRAINT PK_JobInvoiceAttachments PRIMARY KEY (JobInvoiceID, AttachmentID),
    CONSTRAINT FK_InvAtt_Invoice FOREIGN KEY (JobInvoiceID)
      REFERENCES dbo.JobInvoices(JobInvoiceID) ON DELETE CASCADE,
    CONSTRAINT FK_InvAtt_Att FOREIGN KEY (AttachmentID)
      REFERENCES dbo.Attachments(Id) ON DELETE CASCADE
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvAtt_AttachmentID' AND object_id = OBJECT_ID('dbo.JobInvoiceAttachments'))
  CREATE INDEX IX_InvAtt_AttachmentID ON dbo.JobInvoiceAttachments(AttachmentID);
GO
