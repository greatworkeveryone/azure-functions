-- Building trade requirements and explicit contractor coverage. No existing
-- schedules or contractors are rewritten; an absent row means not configured.
IF OBJECT_ID('dbo.MaintenanceCoverage','U') IS NULL
BEGIN
 CREATE TABLE dbo.MaintenanceCoverage (
  BuildingId INT NOT NULL PRIMARY KEY REFERENCES dbo.Buildings(BuildingID),
  PlanJson NVARCHAR(MAX) NOT NULL,
  Revision INT NOT NULL CONSTRAINT DF_MaintenanceCoverage_Revision DEFAULT 1,
  UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_MaintenanceCoverage_UpdatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedBy NVARCHAR(160) NOT NULL,
  UpdatedByOid NVARCHAR(64) NOT NULL,
  CONSTRAINT CK_MaintenanceCoverage_Json CHECK (ISJSON(PlanJson)=1)
 );
END;
IF OBJECT_ID('dbo.MaintenanceCoverageAudit','U') IS NULL
BEGIN
 CREATE TABLE dbo.MaintenanceCoverageAudit (
  AuditId BIGINT IDENTITY(1,1) PRIMARY KEY,
  BuildingId INT NOT NULL REFERENCES dbo.Buildings(BuildingID),
  Revision INT NOT NULL,
  BeforeJson NVARCHAR(MAX) NULL,
  AfterJson NVARCHAR(MAX) NOT NULL,
  ActorName NVARCHAR(160) NOT NULL,
  ActorOid NVARCHAR(64) NOT NULL,
  CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_MaintenanceCoverageAudit_CreatedAt DEFAULT SYSUTCDATETIME()
 );
 CREATE INDEX IX_MaintenanceCoverageAudit_Building ON dbo.MaintenanceCoverageAudit(BuildingId,AuditId);
END;
-- Contractor insurance originals use the existing Documentation register.
IF COL_LENGTH('dbo.RegisterDocuments','ContractorId') IS NULL
 ALTER TABLE dbo.RegisterDocuments ADD ContractorId INT NULL;
IF COL_LENGTH('dbo.RegisterDocuments','InsuranceType') IS NULL
 ALTER TABLE dbo.RegisterDocuments ADD InsuranceType NVARCHAR(100) NULL;
