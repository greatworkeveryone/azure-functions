-- Original evidence files plus explicit, user-recorded lifecycle dates. No statutory interval is inferred.
IF OBJECT_ID('dbo.RegisterDocuments','U') IS NULL
BEGIN
 CREATE TABLE dbo.RegisterDocuments (
  DocumentId INT IDENTITY(1,1) PRIMARY KEY,
  Title NVARCHAR(200) NOT NULL,
  Kind VARCHAR(24) NOT NULL,
  ServiceCategory NVARCHAR(100) NOT NULL,
  BuildingId INT NULL REFERENCES dbo.Buildings(BuildingID),
  TenantId INT NULL REFERENCES dbo.Tenants(TenantId),
  IssuedOn DATE NULL, ExpiresOn DATE NULL, ReviewDue DATE NULL,
  OwnerName NVARCHAR(160) NOT NULL,
  Notes NVARCHAR(MAX) NOT NULL,
  FileName NVARCHAR(200) NOT NULL, BlobName NVARCHAR(1024) NOT NULL,
  ContentType VARCHAR(100) NOT NULL, SizeBytes INT NOT NULL,
  Revision INT NOT NULL DEFAULT 1,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CreatedBy NVARCHAR(160) NOT NULL, CreatedByOid NVARCHAR(64) NOT NULL,
  UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ArchivedAt DATETIME2 NULL,
  CONSTRAINT CK_RegisterDocuments_Kind CHECK (Kind IN ('certificate','report','plan','manual','policy','other')),
  CONSTRAINT CK_RegisterDocuments_Dates CHECK (IssuedOn IS NULL OR ExpiresOn IS NULL OR ExpiresOn >= IssuedOn)
 );
 CREATE INDEX IX_RegisterDocuments_Dates ON dbo.RegisterDocuments (BuildingId,ExpiresOn,ReviewDue);
 CREATE TABLE dbo.RegisterDocumentAudit (
  AuditId INT IDENTITY(1,1) PRIMARY KEY,
  DocumentId INT NOT NULL REFERENCES dbo.RegisterDocuments(DocumentId),
  Action VARCHAR(24) NOT NULL, SnapshotJson NVARCHAR(MAX) NOT NULL,
  ActorName NVARCHAR(160) NOT NULL, ActorOid NVARCHAR(64) NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
 );
END;
