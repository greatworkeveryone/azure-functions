-- Migration 010: Attachments move to Jobs; add PO/Quote join tables.
--
-- Reflects the model shift where every Work Request becomes a Job, and
-- attachments live on the Job from then on. Existing Attachments rows
-- (keyed only by WorkRequestID) are backfilled to JobID via Jobs.WorkRequestID.
-- WorkRequestID is kept on the row as provenance ("came in with this WR")
-- but no new code paths key off it.
--
-- Two thin join tables fan attachments out to PurchaseOrders and Quotes
-- without duplicating blobs — the same Attachment can be referenced from a
-- Job, one or more POs, and one or more Quotes.
--
-- Fully idempotent.

-- ── Attachments: add JobID + backfill, relax WorkRequestID ─────────────────

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Attachments') AND name = 'JobID')
  ALTER TABLE dbo.Attachments ADD JobID INT NULL;
GO

-- Relax WorkRequestID so new job-scoped uploads (no WR) can land. Existing
-- rows keep their WorkRequestID as provenance.
IF EXISTS (
  SELECT 1
    FROM sys.columns
   WHERE object_id = OBJECT_ID('dbo.Attachments')
     AND name = 'WorkRequestID'
     AND is_nullable = 0
)
  ALTER TABLE dbo.Attachments ALTER COLUMN WorkRequestID INT NULL;
GO

-- Backfill JobID from the Jobs row that already references the same WR.
-- NULLs remain on rows whose WR has not been promoted to a Job yet — those
-- get claimed when the Job is created (see upsertJob).
UPDATE a
   SET a.JobID = j.JobID
  FROM dbo.Attachments a
  JOIN dbo.Jobs j ON j.WorkRequestID = a.WorkRequestID
 WHERE a.JobID IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Attachments_JobID' AND object_id = OBJECT_ID('dbo.Attachments'))
  CREATE INDEX IX_Attachments_JobID ON dbo.Attachments(JobID);
GO

-- ── PurchaseOrderAttachments ────────────────────────────────────────────────
-- Many-to-many between POs and Attachments. Cascading delete from PO clears
-- the link without touching the underlying Attachment row (the file may still
-- be referenced from the Job or another PO/Quote).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PurchaseOrderAttachments')
BEGIN
  CREATE TABLE dbo.PurchaseOrderAttachments (
    PurchaseOrderID  INT            NOT NULL,
    AttachmentID     INT            NOT NULL,
    AttachedAt       DATETIME2      NOT NULL CONSTRAINT DF_POAtt_AttachedAt DEFAULT SYSUTCDATETIME(),
    AttachedBy       NVARCHAR(200)  NULL,
    CONSTRAINT PK_PurchaseOrderAttachments PRIMARY KEY (PurchaseOrderID, AttachmentID),
    CONSTRAINT FK_POAtt_PO  FOREIGN KEY (PurchaseOrderID)
      REFERENCES dbo.PurchaseOrders(PurchaseOrderID) ON DELETE CASCADE,
    CONSTRAINT FK_POAtt_Att FOREIGN KEY (AttachmentID)
      REFERENCES dbo.Attachments(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_POAtt_AttachmentID ON dbo.PurchaseOrderAttachments(AttachmentID);
END
GO

-- ── QuoteAttachments ────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'QuoteAttachments')
BEGIN
  CREATE TABLE dbo.QuoteAttachments (
    QuoteID          INT            NOT NULL,
    AttachmentID     INT            NOT NULL,
    AttachedAt       DATETIME2      NOT NULL CONSTRAINT DF_QtAtt_AttachedAt DEFAULT SYSUTCDATETIME(),
    AttachedBy       NVARCHAR(200)  NULL,
    CONSTRAINT PK_QuoteAttachments PRIMARY KEY (QuoteID, AttachmentID),
    CONSTRAINT FK_QtAtt_Quote FOREIGN KEY (QuoteID)
      REFERENCES dbo.Quotes(QuoteID) ON DELETE CASCADE,
    CONSTRAINT FK_QtAtt_Att   FOREIGN KEY (AttachmentID)
      REFERENCES dbo.Attachments(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_QtAtt_AttachmentID ON dbo.QuoteAttachments(AttachmentID);
END
GO
