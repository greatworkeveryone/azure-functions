-- 053_carparks.sql
--
-- Building-level carparks (car bays for now; more Types to come). Each row is
-- a bay that can be allocated to a Tenant, marked Vacant, marked Not
-- Available (out of service / leased to a non-tenant occupant), or assigned
-- to "Randazzo Properties" (owner-retained bays). The allocation is modelled
-- as a discriminated kind + optional TenantId rather than a synthetic-tenant
-- pattern, because non-tenant allocations don't have rent-review / lease /
-- contact data and shouldn't pollute the Tenants table.
--
-- Pricing is canonicalised on RentPerAnnum. Monthly/weekly are derived
-- (annum / 12, annum / 52) — the UI lets the user edit any of the three and
-- syncs the others on blur.
--
-- Re-runnable (idempotent column/constraint adds).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Carparks' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.Carparks (
    CarparkId        NVARCHAR(50)   NOT NULL PRIMARY KEY,
    BuildingId       INT            NOT NULL,
    -- Type discriminator. "carBay" for now; "motorbikeBay", "loadingBay" etc.
    -- will land later. Stored as a string (not an enum table) so adding new
    -- kinds is an app-level change, not a schema migration.
    Type             NVARCHAR(40)   NOT NULL,
    -- Bay code displayed to the user (e.g. "C1", "B-12"). Unique per
    -- building so the spreadsheet view can key on it.
    Identifier       NVARCHAR(60)   NOT NULL,
    -- Allocation discriminator. One of:
    --   tenant       — TenantId is set, bay is leased to a register tenant
    --   vacant       — bay is empty / available
    --   notAvailable — bay is out of service (works, repairs, leased off-register)
    --   randazzo     — owner-retained ("Randazzo Properties")
    AllocationKind   NVARCHAR(20)   NOT NULL,
    TenantId         INT            NULL,
    -- Canonical rent stored as annual. UI derives monthly/weekly.
    RentPerAnnum     DECIMAL(12,2)  NULL,
    Comments         NVARCHAR(MAX)  NULL,
    CreatedAt        DATETIME2      NOT NULL CONSTRAINT DF_Carparks_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt        DATETIME2      NOT NULL CONSTRAINT DF_Carparks_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Carparks_AllocationKind CHECK (
      AllocationKind IN ('tenant','vacant','notAvailable','randazzo')
    ),
    -- If AllocationKind = tenant, TenantId must be set. Otherwise it must be
    -- NULL so the data model can't drift into "ghost tenant" territory.
    CONSTRAINT CK_Carparks_TenantConsistency CHECK (
      (AllocationKind = 'tenant' AND TenantId IS NOT NULL)
      OR (AllocationKind <> 'tenant' AND TenantId IS NULL)
    )
  );
END;
GO

-- Unique bay code per building. Composite key keeps re-imports idempotent at
-- the cell level: an upsert can find the existing bay by (BuildingId,
-- Identifier) when the client mints a fresh CarparkId.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UX_Carparks_BuildingIdentifier'
    AND object_id = OBJECT_ID('dbo.Carparks')
)
  CREATE UNIQUE INDEX UX_Carparks_BuildingIdentifier
    ON dbo.Carparks (BuildingId, Identifier);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Carparks_TenantId'
    AND object_id = OBJECT_ID('dbo.Carparks')
)
  CREATE INDEX IX_Carparks_TenantId ON dbo.Carparks (TenantId);
GO

-- Drop the legacy Level column for environments where the table was created
-- before the column was removed. Safe to re-run.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE name = 'Level'
    AND object_id = OBJECT_ID('dbo.Carparks')
)
  ALTER TABLE dbo.Carparks DROP COLUMN Level;
GO
