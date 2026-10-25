-- Supplemental building/lot records, separate from source-synced identity.
-- No portfolio rows, original documents or source fields are rewritten.
IF OBJECT_ID('dbo.BuildingRegister','U') IS NULL
BEGIN
 CREATE TABLE dbo.BuildingRegister (
  BuildingId INT NOT NULL PRIMARY KEY REFERENCES dbo.Buildings(BuildingID),
  ProfileJson NVARCHAR(MAX) NOT NULL,
  Revision INT NOT NULL CONSTRAINT DF_BuildingRegister_Revision DEFAULT 1,
  UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_BuildingRegister_UpdatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedBy NVARCHAR(160) NOT NULL,
  UpdatedByOid NVARCHAR(64) NOT NULL,
  CONSTRAINT CK_BuildingRegister_Json CHECK (ISJSON(ProfileJson)=1)
 );
END;
IF OBJECT_ID('dbo.BuildingRegisterAudit','U') IS NULL
BEGIN
 CREATE TABLE dbo.BuildingRegisterAudit (
  AuditId BIGINT IDENTITY(1,1) PRIMARY KEY,
  BuildingId INT NOT NULL REFERENCES dbo.Buildings(BuildingID),
  Revision INT NOT NULL,
  BeforeJson NVARCHAR(MAX) NULL,
  AfterJson NVARCHAR(MAX) NOT NULL,
  ActorName NVARCHAR(160) NOT NULL,
  ActorOid NVARCHAR(64) NOT NULL,
  CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_BuildingRegisterAudit_CreatedAt DEFAULT SYSUTCDATETIME()
 );
 CREATE INDEX IX_BuildingRegisterAudit_Building ON dbo.BuildingRegisterAudit(BuildingId,AuditId);
END;
