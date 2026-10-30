-- 184: tenant page (TR3, PLAN §15). Additive and idempotent; nothing existing is rewritten.
--
--   WorkRequests   SourceKind / SourceTenantId / SourceContactId say a request came through a tenant's
--                  personal link and from which tenancy and contact. The tenant page lists requests by
--                  SourceTenantId, so these are its scope. TenantCategory is the category the tenant
--                  chose; Triage* is the staff-only suggestion (rules or AI) and is never shown to the tenant.
--   TenantRequestPhotos  one row per photo, pointing at a blob in the private tenant-quarantine
--                  container. Processed stays 0 until a decoder re-encodes it (none exists yet).
--   Buildings.EmergencyPhone  the number shown first for an emergency; optional (the app setting
--                  TENANT_EMERGENCY_PHONE is the fallback).
--
-- RUNBOOK: apply (needs 183) before turning on the tenantPage flag.

IF COL_LENGTH('dbo.WorkRequests', 'SourceKind') IS NULL ALTER TABLE dbo.WorkRequests ADD SourceKind NVARCHAR(30) NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'SourceTenantId') IS NULL ALTER TABLE dbo.WorkRequests ADD SourceTenantId INT NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'SourceContactId') IS NULL ALTER TABLE dbo.WorkRequests ADD SourceContactId INT NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'TenantCategory') IS NULL ALTER TABLE dbo.WorkRequests ADD TenantCategory NVARCHAR(50) NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'TriageCategory') IS NULL ALTER TABLE dbo.WorkRequests ADD TriageCategory NVARCHAR(50) NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'TriageUrgency') IS NULL ALTER TABLE dbo.WorkRequests ADD TriageUrgency NVARCHAR(20) NULL;
GO
IF COL_LENGTH('dbo.WorkRequests', 'TriageSource') IS NULL ALTER TABLE dbo.WorkRequests ADD TriageSource NVARCHAR(10) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_WorkRequests_SourceTenant' AND object_id = OBJECT_ID('dbo.WorkRequests'))
  CREATE INDEX IX_WorkRequests_SourceTenant ON dbo.WorkRequests (SourceTenantId, CreatedAt DESC) WHERE SourceTenantId IS NOT NULL;
GO

IF COL_LENGTH('dbo.Buildings', 'EmergencyPhone') IS NULL ALTER TABLE dbo.Buildings ADD EmergencyPhone NVARCHAR(50) NULL;
GO

IF OBJECT_ID('dbo.TenantRequestPhotos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TenantRequestPhotos (
    PhotoId       INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_TenantRequestPhotos PRIMARY KEY,
    WorkRequestID INT           NOT NULL,
    TenantId      INT           NOT NULL,
    ContactId     INT           NOT NULL,
    BlobName      NVARCHAR(400) NOT NULL,
    ContentType   NVARCHAR(50)  NOT NULL,
    SizeBytes     BIGINT        NOT NULL,
    Sha256        BINARY(32)    NOT NULL,
    Processed     BIT           NOT NULL CONSTRAINT DF_TenantRequestPhotos_Processed DEFAULT 0,
    UploadedAt    DATETIME2     NOT NULL CONSTRAINT DF_TenantRequestPhotos_UploadedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantRequestPhotos_Request' AND object_id = OBJECT_ID('dbo.TenantRequestPhotos'))
  CREATE INDEX IX_TenantRequestPhotos_Request ON dbo.TenantRequestPhotos (WorkRequestID, TenantId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenantRequestPhotos_Tenant' AND object_id = OBJECT_ID('dbo.TenantRequestPhotos'))
  CREATE INDEX IX_TenantRequestPhotos_Tenant ON dbo.TenantRequestPhotos (TenantId, UploadedAt DESC);
GO
