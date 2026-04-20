-- Migration 017: Job Invoices
--
-- Adds the JobInvoices table for accounts-team invoice review. Unlike the
-- existing Invoices table (which syncs from myBuildings), JobInvoices are
-- local-authoritative: created manually by the accounts team or injected by
-- the email pipeline. Status flows pending → approved | rejected.
--
-- Also adds InvoiceID to JobEvents so invoice lifecycle events carry a typed
-- reference, mirroring the existing QuoteID column.
--
-- Fully idempotent: all DDL guarded with existence checks.

-- ── JobInvoices ──────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'JobInvoices')
BEGIN
  CREATE TABLE dbo.JobInvoices (
    JobInvoiceID        INT            IDENTITY(1,1) PRIMARY KEY,
    JobID               INT            NOT NULL,
    InvoiceNumber       NVARCHAR(50)   NULL,
    Seq                 INT            NULL,
    ContractorName      NVARCHAR(255)  NULL,
    Amount              DECIMAL(18,2)  NULL,
    Currency            NVARCHAR(10)   NOT NULL CONSTRAINT DF_JobInvoices_Currency DEFAULT 'AUD',
    Notes               NVARCHAR(MAX)  NULL,
    InvoicePDFBlobName  NVARCHAR(400)  NULL,
    SourceEmailID       INT            NULL,
    ReceivedAt          DATETIME2      NULL,
    Status              NVARCHAR(20)   NOT NULL CONSTRAINT DF_JobInvoices_Status DEFAULT 'pending',
    ApprovedAt          DATETIME2      NULL,
    ApprovedBy          NVARCHAR(200)  NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_JobInvoices_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy           NVARCHAR(200)  NULL,
    CONSTRAINT FK_JobInvoices_Jobs FOREIGN KEY (JobID)
      REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE
  );

  CREATE INDEX IX_JobInvoices_JobID  ON dbo.JobInvoices(JobID);
  CREATE INDEX IX_JobInvoices_Status ON dbo.JobInvoices(Status);
END
GO

-- ── JobEvents: InvoiceID reference ───────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'InvoiceID')
  ALTER TABLE dbo.JobEvents ADD InvoiceID INT NULL;
GO
