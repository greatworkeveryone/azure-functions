-- Migration 015: Tenants.
--
-- A Tenant is a party that occupies one or more levels of a building. Jobs
-- can be assigned to a tenant so on-charge flows (see migration 011) know
-- who to recoup from.
--
-- Column choices:
--   TenantID             → INT IDENTITY PK so we own the surrogate key;
--                          pairs with ThirdPartyTenantID for the external
--                          (myBuildings) identifier when syncing.
--   ThirdPartyTenantID   → upstream reference, nullable for tenants we
--                          create ourselves before they exist upstream.
--   TenantName           → required display name.
--   BuildingID           → which building the tenant sits in (a tenant
--                          spanning two buildings is two tenants here).
--                          Plain INT — no FK constraint, matching the
--                          existing Jobs.BuildingID convention.
--   Levels               → JSON array of level names the tenant occupies,
--                          e.g. `["Level 3","Level 4"]`. JSON (not a join
--                          table) because the common ops are edit-as-a-set
--                          and display-as-a-list — not "find all tenants
--                          on level X". If that query need shows up later,
--                          switch to a TenantLevels join without breaking
--                          the column shape.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Tenants')
BEGIN
  CREATE TABLE dbo.Tenants (
    TenantID            INT            IDENTITY(1,1) PRIMARY KEY,
    ThirdPartyTenantID  NVARCHAR(100)  NULL,
    TenantName          NVARCHAR(255)  NOT NULL,
    BuildingID          INT            NOT NULL,
    Levels              NVARCHAR(MAX)  NULL,
    CreatedAt           DATETIME2      NOT NULL CONSTRAINT DF_Tenants_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt           DATETIME2      NOT NULL CONSTRAINT DF_Tenants_UpdatedAt DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_Tenants_BuildingID ON dbo.Tenants(BuildingID);
  CREATE INDEX IX_Tenants_ThirdPartyTenantID ON dbo.Tenants(ThirdPartyTenantID)
    WHERE ThirdPartyTenantID IS NOT NULL;
END
GO

-- Link Jobs to a Tenant (optional — the WR-snapshot TenantName column stays
-- as the human-readable display, TenantID is the structured reference used
-- by the on-charge flow). Nullable so legacy jobs + internal jobs don't
-- require a tenant.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'TenantID')
  ALTER TABLE dbo.Jobs ADD TenantID INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Jobs_Tenants')
  ALTER TABLE dbo.Jobs
    ADD CONSTRAINT FK_Jobs_Tenants FOREIGN KEY (TenantID)
      REFERENCES dbo.Tenants(TenantID);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Jobs_TenantID' AND object_id = OBJECT_ID('dbo.Jobs'))
  CREATE INDEX IX_Jobs_TenantID ON dbo.Jobs(TenantID);
GO
