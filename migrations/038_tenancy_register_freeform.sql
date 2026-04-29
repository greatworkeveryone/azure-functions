-- 038_tenancy_register_freeform.sql
--
-- Adapts the v2 tenancy register (m037) to the actual spreadsheet shape we're
-- migrating from. Two themes:
--
--   1. Relax over-tight enums. The source spreadsheet has free-form values for
--      ReviewType ("CPI Darwin (June)"), SecurityDepositMethod ("Bank Transfer"),
--      and SecurityDepositRequired ("Amount equal to 3 months rent plus GST" —
--      not a number at all). m037 modelled these as enums / decimals which
--      forced lossy mapping at import time.
--
--   2. Move BusinessTenanciesActApplies up to the tenant. It's a tenancy-level
--      legal status, not per-(level × area), so it lived on the wrong table.
--
-- All Tenants/TenantOccupancies data is sample-only per m037, so the destructive
-- bits (column type changes) skip migration of existing values. Re-runnable.

-- ── Tenants: drop check constraints we want to relax ────────────────────────

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Tenants_ReviewType')
  ALTER TABLE dbo.Tenants DROP CONSTRAINT CK_Tenants_ReviewType;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Tenants_SecurityDepositMethod')
  ALTER TABLE dbo.Tenants DROP CONSTRAINT CK_Tenants_SecurityDepositMethod;
GO

-- ── Tenants.SecurityDepositRequired: DECIMAL → NVARCHAR ─────────────────────
-- ALTER COLUMN can't change DECIMAL → NVARCHAR in place. Drop + re-add. Sample
-- data only, so no value preservation needed.

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'SecurityDepositRequired'
    AND system_type_id = TYPE_ID('decimal')
)
BEGIN
  ALTER TABLE dbo.Tenants DROP COLUMN SecurityDepositRequired;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'SecurityDepositRequired'
)
  ALTER TABLE dbo.Tenants ADD SecurityDepositRequired NVARCHAR(500) NULL;
GO

-- ── Tenants.SecurityDepositMethod: shorten name? no — keep as NVARCHAR(30) ──
-- Already NVARCHAR(30) from m037; relaxing the check above is enough. But
-- "Bank Transfer" + future variants could exceed 30 chars, so widen.

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'SecurityDepositMethod'
    AND max_length / 2 < 100
)
  ALTER TABLE dbo.Tenants ALTER COLUMN SecurityDepositMethod NVARCHAR(100) NULL;
GO

-- ── Tenants.ReviewType: widen + free-form (check already dropped) ───────────

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'ReviewType'
    AND max_length / 2 < 100
)
  ALTER TABLE dbo.Tenants ALTER COLUMN ReviewType NVARCHAR(100) NOT NULL;
GO

-- ── Tenants.BusinessTenanciesActApplies (NEW) ───────────────────────────────

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'BusinessTenanciesActApplies'
)
  ALTER TABLE dbo.Tenants ADD BusinessTenanciesActApplies BIT NULL;
GO

-- ── TenantOccupancies.BusinessTenanciesActApplies: REMOVE ──────────────────
-- Field moves up to Tenants. Sample data only, no value preservation.

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.TenantOccupancies')
    AND name = 'BusinessTenanciesActApplies'
)
  ALTER TABLE dbo.TenantOccupancies DROP COLUMN BusinessTenanciesActApplies;
GO

