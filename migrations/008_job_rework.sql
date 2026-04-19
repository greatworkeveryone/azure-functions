-- Migration 008: Job rework
--
-- Part of the shift where Jobs become the primary record and Work Requests
-- become reference-only intake. This migration:
--
--   1. Expands Jobs with a WR snapshot (JobCode, LevelName, TenantName,
--      Category, Type, SubType, Priority, ExactLocation, ContactName,
--      ContactPhone, ContactEmail, PersonAffected) plus job-native additions
--      (IsInternal, CreationMethod, SourceEmailID, ApprovedQuoteID,
--      ApprovedBy, ApprovedAt). Snapshot fields are copied once at Job
--      creation — later myBuildings WR syncs do not mutate them.
--
--   2. Enriches JobEvents so purchase orders, quotes, assignment changes,
--      and creation provenance live on the same activity feed.
--
--   3. Adds PurchaseOrders and Quotes (PO-{JobID}-{seq} / QT-{JobID}-{seq}
--      numbering is produced at the application layer). ContractorID is
--      nullable — "internal" jobs may have no contractor assigned yet.
--
--   4. Pre-provisions Payments and Emails so their schemas are frozen and
--      the tables are ready when those flows ship.
--
-- Fully idempotent: every column / table / index is guarded with an
-- existence check, so re-running is a no-op.

-- ── Jobs: WR snapshot + job-native additions ────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'JobCode')
  ALTER TABLE dbo.Jobs ADD JobCode NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'LevelName')
  ALTER TABLE dbo.Jobs ADD LevelName NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'TenantName')
  ALTER TABLE dbo.Jobs ADD TenantName NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'Category')
  ALTER TABLE dbo.Jobs ADD Category NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'Type')
  ALTER TABLE dbo.Jobs ADD [Type] NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'SubType')
  ALTER TABLE dbo.Jobs ADD SubType NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'Priority')
  ALTER TABLE dbo.Jobs ADD Priority NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ExactLocation')
  ALTER TABLE dbo.Jobs ADD ExactLocation NVARCHAR(500) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ContactName')
  ALTER TABLE dbo.Jobs ADD ContactName NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ContactPhone')
  ALTER TABLE dbo.Jobs ADD ContactPhone NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ContactEmail')
  ALTER TABLE dbo.Jobs ADD ContactEmail NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'PersonAffected')
  ALTER TABLE dbo.Jobs ADD PersonAffected NVARCHAR(255) NULL;
GO

-- Job-native additions
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'IsInternal')
  ALTER TABLE dbo.Jobs ADD IsInternal BIT NOT NULL CONSTRAINT DF_Jobs_IsInternal DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'CreationMethod')
  ALTER TABLE dbo.Jobs ADD CreationMethod NVARCHAR(20) NOT NULL CONSTRAINT DF_Jobs_CreationMethod DEFAULT 'manual';
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'SourceEmailID')
  ALTER TABLE dbo.Jobs ADD SourceEmailID INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ApprovedQuoteID')
  ALTER TABLE dbo.Jobs ADD ApprovedQuoteID INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ApprovedBy')
  ALTER TABLE dbo.Jobs ADD ApprovedBy NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ApprovedAt')
  ALTER TABLE dbo.Jobs ADD ApprovedAt DATETIME2 NULL;
GO

-- ── JobEvents: extended for PO / quote / assignment / creation events ───────

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'EventType')
  ALTER TABLE dbo.JobEvents ADD EventType NVARCHAR(40) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'PurchaseOrderID')
  ALTER TABLE dbo.JobEvents ADD PurchaseOrderID INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'QuoteID')
  ALTER TABLE dbo.JobEvents ADD QuoteID INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'NewAssignee')
  ALTER TABLE dbo.JobEvents ADD NewAssignee NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'CreationSource')
  ALTER TABLE dbo.JobEvents ADD CreationSource NVARCHAR(20) NULL;
GO

-- ── PurchaseOrders ──────────────────────────────────────────────────────────
-- PONumber is populated by the application as PO-{JobID}-{seq}; seq is the
-- next MAX(seq)+1 within the job. ContractorID nullable so internal jobs can
-- hold a PO that isn't dispatched to an external contractor.
--
-- CostJustification persists the "why no cost estimate?" note the UI asks for
-- when both EstimatedCost and CostNotToExceed are NULL/0. The constraint is a
-- UI-layer gate, not a DB constraint — empty POs are fine at the row level.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PurchaseOrders')
BEGIN
  CREATE TABLE dbo.PurchaseOrders (
    PurchaseOrderID     INT            IDENTITY(1,1) PRIMARY KEY,
    JobID               INT            NOT NULL,
    PONumber            NVARCHAR(50)   NULL,
    Seq                 INT            NULL,
    ContractorID        INT            NULL,
    ContractorName      NVARCHAR(255)  NULL,
    Scope               NVARCHAR(MAX)  NULL,
    EstimatedCost       DECIMAL(18,2)  NULL,
    CostNotToExceed     DECIMAL(18,2)  NULL,
    CostJustification   NVARCHAR(MAX)  NULL,
    EmailSubject        NVARCHAR(500)  NULL,
    EmailBody           NVARCHAR(MAX)  NULL,
    PDFBlobName         NVARCHAR(400)  NULL,
    SentAt              DATETIME2      NULL,
    SentBy              NVARCHAR(200)  NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_POs_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy           NVARCHAR(200)  NULL,
    UpdatedAt           DATETIME2      NOT NULL CONSTRAINT DF_POs_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_POs_Jobs FOREIGN KEY (JobID)
      REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE
  );

  CREATE INDEX IX_POs_JobID        ON dbo.PurchaseOrders(JobID);
  CREATE INDEX IX_POs_ContractorID ON dbo.PurchaseOrders(ContractorID);
END
GO

-- ── Quotes ──────────────────────────────────────────────────────────────────
-- QuoteNumber follows the same pattern: QT-{JobID}-{seq}. SourceEmailID
-- lights up when a quote is extracted from an inbound email.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Quotes')
BEGIN
  CREATE TABLE dbo.Quotes (
    QuoteID             INT            IDENTITY(1,1) PRIMARY KEY,
    JobID               INT            NOT NULL,
    QuoteNumber         NVARCHAR(50)   NULL,
    Seq                 INT            NULL,
    ContractorID        INT            NULL,
    ContractorName      NVARCHAR(255)  NULL,
    Amount              DECIMAL(18,2)  NULL,
    Currency            NVARCHAR(10)   NOT NULL CONSTRAINT DF_Quotes_Currency DEFAULT 'AUD',
    Notes               NVARCHAR(MAX)  NULL,
    QuotePDFBlobName    NVARCHAR(400)  NULL,
    SourceEmailID       INT            NULL,
    ReceivedAt          DATETIME2      NULL,
    Status              NVARCHAR(20)   NOT NULL CONSTRAINT DF_Quotes_Status DEFAULT 'pending',
    ApprovedAt          DATETIME2      NULL,
    ApprovedBy          NVARCHAR(200)  NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_Quotes_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy           NVARCHAR(200)  NULL,
    CONSTRAINT FK_Quotes_Jobs FOREIGN KEY (JobID)
      REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE
  );

  CREATE INDEX IX_Quotes_JobID  ON dbo.Quotes(JobID);
  CREATE INDEX IX_Quotes_Status ON dbo.Quotes(Status);
END
GO

-- ── Payments (reserved — populated when the payment flow ships) ─────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Payments')
BEGIN
  CREATE TABLE dbo.Payments (
    PaymentID           INT            IDENTITY(1,1) PRIMARY KEY,
    JobID               INT            NOT NULL,
    QuoteID             INT            NULL,
    PurchaseOrderID     INT            NULL,
    Amount              DECIMAL(18,2)  NOT NULL,
    -- Variance = Amount - PurchaseOrders.EstimatedCost. Computed in the app
    -- layer so the PO's cost columns can change without a DB trigger.
    Variance            DECIMAL(18,2)  NULL,
    PaidAt              DATETIME2      NULL,
    PaidBy              NVARCHAR(200)  NULL,
    Notes               NVARCHAR(MAX)  NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_Payments_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy           NVARCHAR(200)  NULL,
    CONSTRAINT FK_Payments_Jobs   FOREIGN KEY (JobID)
      REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE,
    CONSTRAINT FK_Payments_Quotes FOREIGN KEY (QuoteID)
      REFERENCES dbo.Quotes(QuoteID)
  );

  CREATE INDEX IX_Payments_JobID ON dbo.Payments(JobID);
END
GO

-- ── Emails (reserved — populated when the incoming-email ingest ships) ──────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Emails')
BEGIN
  CREATE TABLE dbo.Emails (
    EmailID             INT            IDENTITY(1,1) PRIMARY KEY,
    MessageID           NVARCHAR(400)  NULL,
    FromAddress         NVARCHAR(255)  NULL,
    Subject             NVARCHAR(500)  NULL,
    Body                NVARCHAR(MAX)  NULL,
    ReceivedAt          DATETIME2      NULL,
    -- JSON-encoded array of blob names so we don't need an Attachments join
    -- for the common read path. Full attachments table can come later if
    -- we want structured metadata per file.
    AttachmentBlobs     NVARCHAR(MAX)  NULL,
    MatchedJobID        INT            NULL,
    Status              NVARCHAR(20)   NOT NULL CONSTRAINT DF_Emails_Status DEFAULT 'unread',
    ProcessedAt         DATETIME2      NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_Emails_CreatedAt DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_Emails_MatchedJobID ON dbo.Emails(MatchedJobID);
  CREATE INDEX IX_Emails_Status       ON dbo.Emails(Status);
END
GO
