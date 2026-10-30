-- 185_mybuildings_import (TR6) — bookkeeping for the staff-triggered myBuildings import.
-- Additive and idempotent: four new tables, nothing existing is altered, backfilled or deleted.
--
--   MyBuildingsImportRuns         one row per real (not dry) import run, with its per-building counts.
--   MyBuildingsImportRequests     one row per myBuildings work request seen, keyed by the myBuildings id
--                                 (the de-duplication key), and whether its attachments were checked.
--   MyBuildingsImportAttachments  one row per attachment copied into Floorplan, with its source; UNIQUE on
--                                 (WorkRequestID, SourceKey) so a re-run never copies a file twice.
--   MyBuildingsImportFlags        rows the import could not map (no building, no id, a file refused, ...).

IF OBJECT_ID(N'dbo.MyBuildingsImportRuns', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MyBuildingsImportRuns (
    RunId        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyBuildingsImportRuns PRIMARY KEY,
    StartedAt    DATETIME2(3)  NOT NULL CONSTRAINT DF_MyBuildingsImportRuns_StartedAt DEFAULT SYSUTCDATETIME(),
    FinishedAt   DATETIME2(3)  NULL,
    StartedBy    NVARCHAR(255) NOT NULL,
    Since        NVARCHAR(50)  NULL,
    BuildingId   INT           NULL,
    Summary      NVARCHAR(MAX) NULL,
    FlaggedCount INT           NOT NULL CONSTRAINT DF_MyBuildingsImportRuns_Flagged DEFAULT 0
  );
END
GO

IF OBJECT_ID(N'dbo.MyBuildingsImportRequests', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MyBuildingsImportRequests (
    WorkRequestID        INT           NOT NULL CONSTRAINT PK_MyBuildingsImportRequests PRIMARY KEY,
    BuildingName         NVARCHAR(255) NULL,
    FirstRunId           INT           NOT NULL,
    LastRunId            INT           NOT NULL,
    AttachmentsCheckedAt DATETIME2(3)  NULL,
    UpdatedAt            DATETIME2(3)  NOT NULL CONSTRAINT DF_MyBuildingsImportRequests_UpdatedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID(N'dbo.MyBuildingsImportAttachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MyBuildingsImportAttachments (
    Id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyBuildingsImportAttachments PRIMARY KEY,
    WorkRequestID INT            NOT NULL,
    SourceKey     NVARCHAR(400)  NOT NULL,
    SourceName    NVARCHAR(400)  NULL,
    SourceUrl     NVARCHAR(1000) NULL,
    AttachmentId  INT            NOT NULL,
    RunId         INT            NOT NULL,
    ImportedAt    DATETIME2(3)   NOT NULL CONSTRAINT DF_MyBuildingsImportAttachments_ImportedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_MyBuildingsImportAttachments UNIQUE (WorkRequestID, SourceKey)
  );
END
GO

IF OBJECT_ID(N'dbo.MyBuildingsImportFlags', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MyBuildingsImportFlags (
    Id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyBuildingsImportFlags PRIMARY KEY,
    RunId         INT            NOT NULL,
    WorkRequestID INT            NULL,
    BuildingName  NVARCHAR(255)  NULL,
    Kind          NVARCHAR(30)   NOT NULL,
    Reason        NVARCHAR(500)  NOT NULL,
    CreatedAt     DATETIME2(3)   NOT NULL CONSTRAINT DF_MyBuildingsImportFlags_CreatedAt DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_MyBuildingsImportFlags_RunId ON dbo.MyBuildingsImportFlags (RunId);
END
GO
