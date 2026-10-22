-- Local service availability supplements the source contractor record. It does
-- not alter synced contractor details or imply a building contract.
IF OBJECT_ID('dbo.ContractorCoverage','U') IS NULL
BEGIN
 CREATE TABLE dbo.ContractorCoverage (
  ContractorId INT NOT NULL PRIMARY KEY,
  CoverageJson NVARCHAR(MAX) NOT NULL,
  Revision INT NOT NULL CONSTRAINT DF_ContractorCoverage_Revision DEFAULT 1,
  UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_ContractorCoverage_UpdatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedBy NVARCHAR(160) NOT NULL,
  UpdatedByOid NVARCHAR(64) NOT NULL,
  CONSTRAINT CK_ContractorCoverage_Json CHECK (ISJSON(CoverageJson)=1)
 );
END;
IF OBJECT_ID('dbo.ContractorCoverageAudit','U') IS NULL
BEGIN
 CREATE TABLE dbo.ContractorCoverageAudit (
  AuditId BIGINT IDENTITY(1,1) PRIMARY KEY,
  ContractorId INT NOT NULL,
  Revision INT NOT NULL,
  BeforeJson NVARCHAR(MAX) NULL,
  AfterJson NVARCHAR(MAX) NOT NULL,
  ActorName NVARCHAR(160) NOT NULL,
  ActorOid NVARCHAR(64) NOT NULL,
  CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_ContractorCoverageAudit_CreatedAt DEFAULT SYSUTCDATETIME()
 );
 CREATE INDEX IX_ContractorCoverageAudit_Contractor ON dbo.ContractorCoverageAudit(ContractorId,AuditId);
END;
