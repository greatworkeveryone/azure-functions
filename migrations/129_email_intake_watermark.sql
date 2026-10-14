-- 129_email_intake_watermark — per-mailbox email watermark, plus two columns
-- other lane-D packages need, created together so the lane owns one file.
--
--   dbo.EmailSyncState (D7, DL-13)  one row per mailbox: the newest message
--     stored so far (LastReceivedAt, LastMessageId). src/email/mail-sync.ts
--     moves it only after a page of mail is stored, and only forward, so a
--     failed sync re-reads from the last stored page and an ingestEmail with a
--     future date or another mailbox's mail can't skip anyone's inbox.
--   Tenants.ArchivedAt / ArchivedBy (D4, DL-04)  tenancies are archived, not
--     deleted. Same types as Jobs.ArchivedAt / ArchivedBy.
--   WorkRequests.SourceHost (D8, DL-16)  which myBuildings host a mirrored
--     work request came from, so a staging/live cutover can't mix records.
--
-- Additive and re-runnable: every object behind an existence check, every new
-- column nullable. Nothing is backfilled, rewritten or deleted.

IF OBJECT_ID(N'dbo.EmailSyncState', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EmailSyncState (
    Mailbox        NVARCHAR(320) NOT NULL CONSTRAINT PK_EmailSyncState PRIMARY KEY,
    LastReceivedAt DATETIME2(3)  NULL,
    LastMessageId  NVARCHAR(400) NULL,
    UpdatedAt      DATETIME2(3)  NOT NULL CONSTRAINT DF_EmailSyncState_UpdatedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF COL_LENGTH(N'dbo.Tenants', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.Tenants ADD ArchivedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.Tenants', N'ArchivedBy') IS NULL
  ALTER TABLE dbo.Tenants ADD ArchivedBy NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'SourceHost') IS NULL
  ALTER TABLE dbo.WorkRequests ADD SourceHost NVARCHAR(255) NULL;
