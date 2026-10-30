-- 188_tenancy_responsibilities (TR7, PLAN §15): "who maintains what" per tenancy, used when a tenant reports a fault.
--
--   dbo.TenancyResponsibilities  one row per item: "Server room split A/C", its trade category and location, and who
--       maintains it: 'base_building' (the owner pays), 'owner_oncharge' (the owner maintains it for the tenant and
--       on-charges the cost) or 'tenant' (the tenant's own). Optional links to an asset on the register (AssetId) and
--       to the fit-out project that installed it (ProjectEventId, a MajorEvents row with EventClass 'project'), and a
--       drawing reference. No foreign keys to those two: the as-built asset and the project outlive each other.
--       Archived, never deleted (ArchivedAt/ArchivedBy). RowVersion: a stale write is a 409.
--
-- Additive and re-runnable: the table and its index behind existence checks. Nothing existing is rewritten.
-- RUNBOOK: apply before turning on the tenancyResponsibilities flag.

IF OBJECT_ID(N'dbo.TenancyResponsibilities', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TenancyResponsibilities (
    ResponsibilityId INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_TenancyResponsibilities PRIMARY KEY,
    TenantId         INT           NOT NULL CONSTRAINT FK_TenancyResponsibilities_Tenants REFERENCES dbo.Tenants (TenantId),
    Item             NVARCHAR(200) NOT NULL,
    Category         NVARCHAR(50)  NULL,
    Location         NVARCHAR(200) NULL,
    MaintainedBy     VARCHAR(16)   NOT NULL,
    AssetId          INT           NULL,
    ProjectEventId   INT           NULL,
    DrawingRef       NVARCHAR(200) NULL,
    Note             NVARCHAR(1000) NULL,
    CreatedAt        DATETIME2     NOT NULL CONSTRAINT DF_TenancyResponsibilities_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy        NVARCHAR(200) NULL,
    UpdatedAt        DATETIME2     NOT NULL CONSTRAINT DF_TenancyResponsibilities_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy        NVARCHAR(200) NULL,
    ArchivedAt       DATETIME2     NULL,
    ArchivedBy       NVARCHAR(200) NULL,
    RowVersion       ROWVERSION    NOT NULL,
    CONSTRAINT CK_TenancyResponsibilities_MaintainedBy CHECK (MaintainedBy IN ('base_building', 'owner_oncharge', 'tenant'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenancyResponsibilities_TenantId' AND object_id = OBJECT_ID('dbo.TenancyResponsibilities'))
  CREATE INDEX IX_TenancyResponsibilities_TenantId ON dbo.TenancyResponsibilities (TenantId) INCLUDE (ArchivedAt, Category);
GO
