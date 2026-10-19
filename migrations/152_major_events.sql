-- Major Events: scope and coordination only; money approvals stay on jobs.
IF OBJECT_ID('dbo.MajorEvents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MajorEvents (
    EventId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Title NVARCHAR(160) NOT NULL,
    Domain VARCHAR(16) NOT NULL CHECK (Domain IN ('operational','financial')),
    EventType VARCHAR(24) NOT NULL CHECK (EventType IN ('cyclone','flood','shutdown','major_works','financial','other')),
    Status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (Status IN ('active','closed')),
    OwnerName NVARCHAR(160) NOT NULL,
    StartsAt DATETIME2 NOT NULL,
    EndsAt DATETIME2 NULL,
    Brief NVARCHAR(MAX) NOT NULL,
    PlanJson NVARCHAR(MAX) NOT NULL CHECK (ISJSON(PlanJson) = 1),
    Revision INT NOT NULL DEFAULT 1,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedBy NVARCHAR(160) NOT NULL,
    CreatedByOid NVARCHAR(64) NOT NULL,
    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ClosedAt DATETIME2 NULL,
    ClosedBy NVARCHAR(160) NULL
  );
  CREATE INDEX IX_MajorEvents_Status ON dbo.MajorEvents (Status, UpdatedAt DESC);
END;
IF OBJECT_ID('dbo.MajorEventEntries', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MajorEventEntries (
    EntryId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId INT NOT NULL REFERENCES dbo.MajorEvents(EventId),
    EntryType VARCHAR(24) NOT NULL,
    BuildingId INT NULL,
    Area NVARCHAR(200) NULL,
    Body NVARCHAR(MAX) NOT NULL,
    ActorName NVARCHAR(160) NOT NULL,
    ActorOid NVARCHAR(64) NOT NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_MajorEventEntries_Event ON dbo.MajorEventEntries (EventId, EntryId);
END;
IF OBJECT_ID('dbo.MajorEventDocuments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MajorEventDocuments (
    DocumentId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    EventId INT NOT NULL REFERENCES dbo.MajorEvents(EventId),
    EntryId INT NULL REFERENCES dbo.MajorEventEntries(EntryId),
    FileName NVARCHAR(200) NOT NULL,
    BlobName NVARCHAR(1024) NOT NULL,
    ContentType VARCHAR(100) NOT NULL,
    SizeBytes INT NOT NULL,
    UploadedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UploadedBy NVARCHAR(160) NOT NULL
  );
END;
-- Hidden by default; enable explicitly for local/client review.
