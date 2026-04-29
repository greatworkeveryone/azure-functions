-- 034_create_inspections.sql
-- Inspections feature: building walk-throughs with levels → rooms → points.
-- All ID-typed columns on the children are NVARCHAR(40) so the client can
-- generate UUIDs offline and replay them via /applyInspectionOps without
-- needing a server round-trip to mint IDs first.

-- ── Inspections ──────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Inspections')
BEGIN
  CREATE TABLE dbo.Inspections (
    Id              INT IDENTITY(1,1) PRIMARY KEY,
    BuildingId      INT            NOT NULL REFERENCES dbo.Buildings(BuildingID),
    Title           NVARCHAR(200)  NULL,
    Status          NVARCHAR(20)   NOT NULL DEFAULT 'draft',
    Revision        INT            NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedById     NVARCHAR(200)  NOT NULL,
    CreatedByName   NVARCHAR(200)  NOT NULL,
    LastModifiedAt  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    CompletedAt     DATETIME2      NULL,
    CompletedById   NVARCHAR(200)  NULL,
    CompletedByName NVARCHAR(200)  NULL,
    MergedIntoId    INT            NULL REFERENCES dbo.Inspections(Id),
    CONSTRAINT CK_Inspections_Status CHECK (Status IN ('draft','complete','merged'))
  );

  CREATE INDEX IX_Inspections_Building ON dbo.Inspections(BuildingId);
  CREATE INDEX IX_Inspections_Status   ON dbo.Inspections(Status);
END
GO

-- ── Levels ───────────────────────────────────────────────────────────────────
-- ON DELETE CASCADE so deleting an Inspection drops its level tree.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionLevels')
BEGIN
  CREATE TABLE dbo.InspectionLevels (
    Id              NVARCHAR(40)   PRIMARY KEY,
    InspectionId    INT            NOT NULL,
    Name            NVARCHAR(100)  NOT NULL,
    AddedAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    SortOrder       INT            NOT NULL DEFAULT 0,
    CONSTRAINT FK_InspectionLevels_Inspection
      FOREIGN KEY (InspectionId) REFERENCES dbo.Inspections(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_InspectionLevels_Inspection ON dbo.InspectionLevels(InspectionId);
END
GO

-- ── Level contributors (M:N for "added by" attribution that survives merges) ─

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionLevelContributors')
BEGIN
  CREATE TABLE dbo.InspectionLevelContributors (
    LevelId   NVARCHAR(40)   NOT NULL,
    UserId    NVARCHAR(200)  NOT NULL,
    UserName  NVARCHAR(200)  NOT NULL,
    PRIMARY KEY (LevelId, UserId),
    CONSTRAINT FK_InspectionLevelContributors_Level
      FOREIGN KEY (LevelId) REFERENCES dbo.InspectionLevels(Id) ON DELETE CASCADE
  );
END
GO

-- ── Rooms ────────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionRooms')
BEGIN
  CREATE TABLE dbo.InspectionRooms (
    Id              NVARCHAR(40)   PRIMARY KEY,
    LevelId         NVARCHAR(40)   NOT NULL,
    Name            NVARCHAR(200)  NOT NULL,
    Description     NVARCHAR(500)  NULL,
    AddedAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    AddedById       NVARCHAR(200)  NOT NULL,
    AddedByName     NVARCHAR(200)  NOT NULL,
    SortOrder       INT            NOT NULL DEFAULT 0,
    CONSTRAINT FK_InspectionRooms_Level
      FOREIGN KEY (LevelId) REFERENCES dbo.InspectionLevels(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_InspectionRooms_Level ON dbo.InspectionRooms(LevelId);
END
GO

-- ── Points ───────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionPoints')
BEGIN
  CREATE TABLE dbo.InspectionPoints (
    Id              NVARCHAR(40)   PRIMARY KEY,
    RoomId          NVARCHAR(40)   NOT NULL,
    Description     NVARCHAR(MAX)  NOT NULL DEFAULT '',
    AddedAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    AddedById       NVARCHAR(200)  NOT NULL,
    AddedByName     NVARCHAR(200)  NOT NULL,
    LastModifiedAt  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    SortOrder       INT            NOT NULL DEFAULT 0,
    CONSTRAINT FK_InspectionPoints_Room
      FOREIGN KEY (RoomId) REFERENCES dbo.InspectionRooms(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_InspectionPoints_Room ON dbo.InspectionPoints(RoomId);
END
GO

-- ── Attachments ──────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionAttachments')
BEGIN
  CREATE TABLE dbo.InspectionAttachments (
    Id              NVARCHAR(40)   PRIMARY KEY,
    PointId         NVARCHAR(40)   NOT NULL,
    BlobName        NVARCHAR(500)  NOT NULL,
    FileName        NVARCHAR(500)  NOT NULL,
    UploadedAt      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    UploadedById    NVARCHAR(200)  NOT NULL,
    UploadedByName  NVARCHAR(200)  NOT NULL,
    CONSTRAINT FK_InspectionAttachments_Point
      FOREIGN KEY (PointId) REFERENCES dbo.InspectionPoints(Id) ON DELETE CASCADE
  );

  CREATE INDEX IX_InspectionAttachments_Point ON dbo.InspectionAttachments(PointId);
END
GO

-- ── Operation log (idempotency for /applyInspectionOps) ──────────────────────
-- Each client-generated op has a UUID. Once recorded here, replays are skipped.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionOperationLog')
BEGIN
  CREATE TABLE dbo.InspectionOperationLog (
    OpId         NVARCHAR(40)   PRIMARY KEY,
    InspectionId INT            NOT NULL,
    OpType       NVARCHAR(40)   NOT NULL,
    AppliedAt    DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_InspectionOperationLog_Inspection ON dbo.InspectionOperationLog(InspectionId);
END
GO

-- ── Raised jobs link (for /raiseJobsFromInspection) ──────────────────────────
-- A point can be raised more than once (re-raised after a job is closed).

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionRaisedJobs')
BEGIN
  CREATE TABLE dbo.InspectionRaisedJobs (
    Id           INT IDENTITY(1,1) PRIMARY KEY,
    InspectionId INT            NOT NULL REFERENCES dbo.Inspections(Id),
    PointId      NVARCHAR(40)   NOT NULL,
    JobId        INT            NOT NULL,
    RaisedAt     DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    RaisedById   NVARCHAR(200)  NOT NULL
  );

  CREATE INDEX IX_InspectionRaisedJobs_Inspection ON dbo.InspectionRaisedJobs(InspectionId);
  CREATE INDEX IX_InspectionRaisedJobs_Point      ON dbo.InspectionRaisedJobs(PointId);
END
GO

-- ── Merge sources ────────────────────────────────────────────────────────────
-- Records which source inspections were merged into the new one. Each source
-- also gets MergedIntoId set on Inspections directly for fast lookup.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'InspectionMergeSources')
BEGIN
  CREATE TABLE dbo.InspectionMergeSources (
    MergedInspectionId INT NOT NULL REFERENCES dbo.Inspections(Id),
    SourceInspectionId INT NOT NULL REFERENCES dbo.Inspections(Id),
    PRIMARY KEY (MergedInspectionId, SourceInspectionId)
  );
END
GO
