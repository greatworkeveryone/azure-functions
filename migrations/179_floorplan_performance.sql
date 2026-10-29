-- Floorplan performance: improvement records, immutable change history and bounded opt-in request outcomes.
-- Additive and idempotent. No existing business record is rewritten. Collection retains USAGE_TRACKING_ENABLED gating.
IF OBJECT_ID('dbo.PerformanceImprovements','U') IS NULL
BEGIN
 CREATE TABLE dbo.PerformanceImprovements (
  ImprovementId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  DataJson NVARCHAR(MAX) NOT NULL CHECK(ISJSON(DataJson)=1),
  Revision INT NOT NULL DEFAULT 1 CHECK(Revision>0),
  Status NVARCHAR(16) NOT NULL DEFAULT 'open' CHECK(Status IN ('open','closed','archived')),
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CreatedBy NVARCHAR(200) NOT NULL,UpdatedBy NVARCHAR(200) NOT NULL
 );
END;
IF OBJECT_ID('dbo.PerformanceImprovementHistory','U') IS NULL
BEGIN
 CREATE TABLE dbo.PerformanceImprovementHistory (
  HistoryId BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ImprovementId INT NOT NULL REFERENCES dbo.PerformanceImprovements(ImprovementId),
  Revision INT NOT NULL,BeforeJson NVARCHAR(MAX) NULL,AfterJson NVARCHAR(MAX) NOT NULL CHECK(ISJSON(AfterJson)=1),
  ActorOid NVARCHAR(100) NOT NULL,ActorName NVARCHAR(200) NOT NULL,RecordedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
 );
 CREATE UNIQUE INDEX IX_PerformanceImprovementHistory_Revision ON dbo.PerformanceImprovementHistory(ImprovementId,Revision);
END;
IF OBJECT_ID('dbo.WorkflowSignals','U') IS NULL
BEGIN
 CREATE TABLE dbo.WorkflowSignals (
  EventId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,UserId INT NOT NULL REFERENCES dbo.AppUsers(UserID),
  Operation NVARCHAR(40) NOT NULL,Outcome NVARCHAR(24) NOT NULL,DurationMs INT NOT NULL CHECK(DurationMs BETWEEN 0 AND 120000),
  RecordedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
 );
 CREATE INDEX IX_WorkflowSignals_Time ON dbo.WorkflowSignals(RecordedAt) INCLUDE(Operation,Outcome,DurationMs);
END;
-- Defence in depth: improvement history is append-only even if a future handler attempts an edit.
IF OBJECT_ID('dbo.TR_PerformanceImprovementHistory_AppendOnly','TR') IS NULL
 EXEC(N'CREATE TRIGGER dbo.TR_PerformanceImprovementHistory_AppendOnly ON dbo.PerformanceImprovementHistory INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''Improvement history is append-only'', 1; END;');
